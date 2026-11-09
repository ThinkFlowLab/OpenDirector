"""Bounded, process-local, coalesced reads of optional Omni declarations.

This service never wakes a model and never submits inference. A worker owns
each HTTP request; callers share its future with a total two-second deadline.
"""
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from dataclasses import dataclass
import hashlib
import json
import threading
import time

import httpx

from opendirector.domain.omni_capabilities import OmniCapabilities
from opendirector.integrations.http_settings import auth_headers, trust_environment
from opendirector.integrations.volcengine import endpoint

DECLARATION_SECONDS = 30
PAUSE_SECONDS = 5
QUERY_SECONDS = 2
FAILURE_SECONDS = 2


def identity(config, *, service=False):
    keys = ('url', 'apiKey', 'authMode', 'connectionType', 'proxyMode', '_capability_namespace')
    if not service:
        keys += ('id', 'providerId', 'kind', 'modelId', 'protocol', 'videoAdapter', 'inputModalities',
                 'videoCapabilities', 'capabilityAutoCheck')
    value = {key: config.get(key) for key in keys}
    value['serviceId'] = config.get('providerId') or config.get('id')
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def automatic(config):
    return config.get('capabilityAutoCheck', config.get('connectionType') == 'self_hosted')


@dataclass(frozen=True)
class Observation:
    document: OmniCapabilities | None
    reason: str
    checked: float
    expires: float
    received: float
    valid_until: float


class CapabilityProbe:
    def __init__(self, *, transport=None, clock=time.monotonic, wall_clock=time.time, timeout=QUERY_SECONDS, capacity=128):
        self.transport, self.clock, self.timeout, self.capacity = transport, clock, timeout, capacity
        self.wall_clock = wall_clock
        self._lock = threading.Lock()
        self._cache = OrderedDict()
        self._pending: dict[str, Future] = {}
        self._workers = ThreadPoolExecutor(max_workers=4, thread_name_prefix='capabilities')

    def close(self):
        self._workers.shutdown(wait=False, cancel_futures=True)

    def _observation(self, document, reason):
        lifetime = DECLARATION_SECONDS if document else FAILURE_SECONDS
        received, checked = self.clock(), self.wall_clock()
        return Observation(document, reason, checked, checked + lifetime, received, received + lifetime)

    def peek(self, config):
        key = identity(config, service=True)
        with self._lock:
            observation = self._cache.get(key)
            return observation if observation and observation.valid_until > self.clock() else None

    def query(self, config, *, manual=False):
        return self.query_many([config], manual=manual)[0]

    def query_many(self, configs, *, manual=False):
        """Start independent services together and share one caller deadline.

        The same bounded worker pool and pending map serve both one-model
        admission and directory refreshes; queued requests inherit the deadline.
        """
        deadline = time.monotonic() + self.timeout
        pending = [(config, self._start(config, manual, deadline)) for config in configs]
        return [self._wait(config, value, deadline) if isinstance(value, Future) else value
                for config, value in pending]

    def _start(self, config, manual, deadline):
        if not manual and not automatic(config):
            return self.peek(config)
        key = identity(config, service=True)
        with self._lock:
            observation = self._cache.get(key)
            # Paused observations need another read after their shorter lifetime.
            paused = observation and observation.document and any(
                op.execution.state == 'paused' for model in observation.document.models for op in model.operations.values())
            if (not manual and observation and observation.valid_until > self.clock()
                    and (not paused or observation.received + PAUSE_SECONDS > self.clock())):
                return observation
            future = self._pending.get(key)
            if future is None:
                if len(self._pending) >= self.capacity or time.monotonic() >= deadline:
                    value = self._observation(None, 'query_busy' if len(self._pending) >= self.capacity else 'query_timeout')
                    self._cache[key] = value
                    while len(self._cache) > self.capacity:
                        self._cache.popitem(last=False)
                    return value
                future = self._workers.submit(self._read, dict(config), deadline)
                self._pending[key] = future
                # Register outside the lock: already-completed futures invoke callbacks inline.
                register = True
            else:
                register = False
        if register:
            future.add_done_callback(lambda done: self._finish(key, done))
        return future

    def _wait(self, config, future, deadline):
        key = identity(config, service=True)
        try:
            value = future.result(timeout=max(0, deadline - time.monotonic()))
            # Future.result may wake before its completion callback publishes.
            self._finish(key, future)
            return value
        except TimeoutError:
            value = self._observation(None, 'query_timeout')
            with self._lock:
                if self._pending.get(key) is future:
                    self._cache[key] = value
                    while len(self._cache) > self.capacity:
                        self._cache.popitem(last=False)
            return value

    def _finish(self, key, future):
        try:
            value = future.result()
        except Exception:
            value = self._observation(None, 'query_failed')
        with self._lock:
            if self._pending.get(key) is not future:
                return  # A waiter already published it; do not overwrite a newer refresh.
            self._pending.pop(key, None)
            self._cache[key] = value
            self._cache.move_to_end(key)
            while len(self._cache) > self.capacity:
                self._cache.popitem(last=False)

    def _read(self, config, deadline):
        reason, document = 'query_failed', None
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            with httpx.Client(transport=self.transport, trust_env=trust_environment(config['url'], config=config),
                              timeout=remaining, follow_redirects=False) as client:
                with client.stream('GET', endpoint(config['url'], '/omni/capabilities'), headers=auth_headers(config)) as response:
                    if response.status_code != 200:
                        reason = ('authentication_failed' if response.status_code in {401, 403}
                                  else 'protocol_unavailable' if response.status_code == 404 else 'query_failed')
                    else:
                        data = bytearray()
                        for chunk in response.iter_bytes():
                            if time.monotonic() >= deadline:
                                raise TimeoutError()
                            data.extend(chunk)
                            if len(data) > 1024 * 1024:
                                raise ValueError('response too large')
                        decoded = json.loads(data)
                        if isinstance(decoded, dict) and decoded.get('object') != 'omni.capabilities':
                            reason = 'protocol_unavailable'
                        elif isinstance(decoded, dict) and type(decoded.get('schema_version')) is not int:
                            reason = 'invalid_response'
                        elif isinstance(decoded, dict) and decoded.get('schema_version') != 1:
                            reason = 'unsupported_version'
                        else:
                            document = OmniCapabilities.model_validate(decoded)
                            reason = 'observed'
            if time.monotonic() > deadline:
                raise TimeoutError()
        except (httpx.TimeoutException, TimeoutError):
            reason, document = 'query_timeout', None
        except httpx.HTTPError:
            reason, document = 'connection_failed', None
        except (ValueError, TypeError, RecursionError):
            reason, document = 'invalid_response', None
        return self._observation(document, reason)
