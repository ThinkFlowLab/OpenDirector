"""One pin-to-public-address guard for every unconfigured download host."""
import asyncio
import socket
import threading
import time

import pytest

from opendirector.application.voice_library import _public_https
from opendirector.domain.generation import GenerationError
from opendirector.domain.projects import ProjectError
from opendirector.integrations import http_settings
from opendirector.integrations.volcengine import _public_result_url


@pytest.fixture
def answers(monkeypatch):
    values, calls = ['93.184.216.34'], []

    def lookup(host, port, **kwargs):
        calls.append((host, port))
        return [(socket.AF_INET6 if ':' in value else socket.AF_INET, socket.SOCK_STREAM, 6, '', (value, port))
                for value in values]

    monkeypatch.setattr(socket, 'getaddrinfo', lookup)
    return values, calls


UNSAFE = [
    'https://127.0.0.1/x.wav', 'https://localhost/x.wav', 'https://a.localhost./x.wav',
    'https://[fe80::1%25eth0]/x.wav', 'https://user:pw@cdn.test/x.wav',
    'https://cdn.test:notaport/x.wav', 'https://cdn.test:99999/x.wav', 'https://[broken/x.wav',
]


@pytest.mark.parametrize('url', UNSAFE)
def test_both_callers_reject_the_same_unsafe_urls_before_dns(url, answers):
    with pytest.raises(ProjectError) as error:
        _public_https(url)
    assert error.value.code == 'voice_provider_error' and error.value.status == 502
    with pytest.raises(GenerationError):
        asyncio.run(_public_result_url(url))
    assert answers[1] == []


def test_voice_preview_is_https_only(answers):
    with pytest.raises(ProjectError):
        _public_https('http://cdn.test/x.wav')
    assert answers[1] == []


@pytest.mark.parametrize('address', ['10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '224.0.0.1'])
def test_any_private_answer_rejects_the_host(address, answers):
    answers[0][:] = ['93.184.216.34', address]
    with pytest.raises(ProjectError):
        _public_https('https://cdn.test/x.wav')
    with pytest.raises(GenerationError):
        asyncio.run(_public_result_url('https://cdn.test/x.wav'))


def test_pinned_address_is_normalised_and_keeps_tls_identity(answers):
    answers[0][:] = ['2606:4700:4700:0:0:0:0:1111']
    for target, headers, extensions in (_public_https('https://cdn.test:8443/x.wav?a=1'),
                                        asyncio.run(_public_result_url('https://cdn.test:8443/x.wav?a=1'))):
        assert target.host == '2606:4700:4700::1111' and target.port == 8443 and target.query == b'a=1'
        assert headers == {'Host': 'cdn.test:8443', 'Connection': 'close'}
        assert extensions == {'sni_hostname': 'cdn.test'}
    assert answers[1] == [('cdn.test', 8443), ('cdn.test', 8443)]


def hung(monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(http_settings, 'PUBLIC_LOOKUP_SECONDS', 0.2)
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *args, **kwargs: release.wait(10) and [])
    return release


def test_a_hung_resolver_is_cut_off_for_the_sync_caller(monkeypatch):
    release = hung(monkeypatch)
    started = time.monotonic()
    try:
        with pytest.raises(ProjectError) as error:
            _public_https('https://cdn.test/x.wav')
        assert error.value.code == 'voice_provider_error'
        assert time.monotonic() - started < 2
    finally:
        release.set()


def test_a_hung_resolver_is_cut_off_for_the_async_caller(monkeypatch):
    release = hung(monkeypatch)
    loop = asyncio.new_event_loop()
    started = time.monotonic()
    try:
        with pytest.raises(GenerationError) as error:
            loop.run_until_complete(_public_result_url('https://cdn.test/x.wav'))
        assert error.value.details.stage == 'download'
        assert time.monotonic() - started < 2
    finally:
        release.set()
        loop.run_until_complete(loop.shutdown_default_executor())
        loop.close()
