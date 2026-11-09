#!/usr/bin/env python3
"""Verify a deployed service; --infer explicitly submits one real generation.

Uses Pillow or ffprobe for actual output validation. Reports distinguish technical
success from creative review, and never retry a possibly accepted generation.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import threading
import time
from uuid import uuid4

if __package__:
    from .deploy import (DeploymentError, capture, load_profile, profile_digest, read_json,
                         readiness, request_json, write_json)
else:
    from deploy import (DeploymentError, capture, load_profile, profile_digest, read_json,
                        readiness, request_json, write_json)


def media_facts(path, kind, python):
    if kind == 'image':
        script = '''import json,sys
from PIL import Image
with Image.open(sys.argv[1]) as image:
    facts={'format':image.format,'width':image.width,'height':image.height}
    image.verify()
with Image.open(sys.argv[1]) as image:
    image.load()
print(json.dumps(facts))
'''
        value = capture([python, '-c', script, str(path)])
        if value is None:
            raise DeploymentError('invalid_image_output')
        facts = json.loads(value)
        if facts['format'] != 'PNG':
            raise DeploymentError('invalid_image_output')
        return facts
    value = capture(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)])
    if value is None:
        raise DeploymentError('invalid_audio_output')
    probe = json.loads(value)
    streams = [item for item in probe.get('streams', []) if item['codec_type'] == 'audio']
    if not streams or float(probe.get('format', {}).get('duration', 0)) <= 0:
        raise DeploymentError('invalid_audio_output')
    return dict(codec=streams[0]['codec_name'], sampleRate=int(streams[0]['sample_rate']),
                channels=streams[0]['channels'], durationSeconds=float(probe['format']['duration']))


class GpuSampler:
    """Whole-device samples include other workloads; they are not allocator peaks."""
    def __init__(self, identity):
        self.identity = identity
        self.samples = []
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.done.is_set():
            value = capture(['nvidia-smi', '--id=' + self.identity,
                             '--query-gpu=memory.used', '--format=csv,noheader,nounits'], timeout=3)
            try:
                self.samples.append(int(value))
            except (TypeError, ValueError):
                pass
            self.done.wait(0.5)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.done.set()
        self.thread.join(timeout=4)

    def facts(self):
        return dict(scope='whole_device_including_other_workloads', intervalSeconds=0.5,
                    sampleCount=len(self.samples), sampledPeakMiB=max(self.samples) if self.samples else None)


def verify(root, profile, *, infer=False, url=None, timeout=240):
    state_path = root / 'services' / profile['id'] / 'state.json'
    if url is None and not state_path.is_file():
        raise DeploymentError('service_not_started', profile=profile['id'])
    state = read_json(state_path) if url is None else {}
    url = (url or state['url']).rstrip('/')
    readiness(url, profile['modelId'])
    report = dict(schemaVersion=1, runId=str(uuid4()), status='service_ready', modelId=profile['modelId'],
                  revision=profile['revision'], profileSha256=profile_digest(profile), url=url,
                  startedAt=datetime.now(timezone.utc).isoformat(), creativeReview='pending')
    if not infer:
        return report
    directory = root / 'outputs' / report['runId']
    directory.mkdir(parents=True)
    receipt = directory / 'verification.json'
    payload = dict(profile['verification']['request'], model=profile['modelId'])
    report.update(status='submission_started', request=payload)
    write_json(receipt, report)
    sampler = GpuSampler(state['gpuUuid']) if state else None
    started = time.monotonic()
    try:
        if sampler:
            sampler.__enter__()
        raw = request_json(url + profile['verification']['path'], payload, timeout)
        elapsed = time.monotonic() - started
        kind = profile['verification']['kind']
        if kind == 'image':
            raw = base64.b64decode(json.loads(raw)['data'][0]['b64_json'], validate=True)
        path = directory / ('result.png' if kind == 'image' else 'result.mp3')
        with path.open('xb') as out:
            out.write(raw)
        facts = media_facts(path, kind, str(root / 'omni-env/bin/python'))
        if kind == 'image':
            expected = profile['verification']['request']['size']
            if f"{facts['width']}x{facts['height']}" != expected:
                raise DeploymentError('output_dimensions_mismatch', actual=facts, expected=expected)
        report.update(status='inference_verified', elapsedSeconds=round(elapsed, 3), artifact=str(path),
                      artifactSha256=hashlib.sha256(raw).hexdigest(), media=facts)
    except DeploymentError as error:
        report.update(status='submission_unknown' if error.code == 'service_unreachable' else 'failed', code=error.code,
                      elapsedSeconds=round(time.monotonic() - started, 3))
        write_json(receipt, report)
        raise DeploymentError('inference_result_unknown' if report['status'] == 'submission_unknown' else error.code,
                              receipt=str(receipt)) from None
    except (ValueError, KeyError, TypeError, IndexError):
        report.update(status='failed', code='invalid_provider_output')
        write_json(receipt, report)
        raise DeploymentError('invalid_provider_output', receipt=str(receipt)) from None
    finally:
        if sampler:
            sampler.__exit__()
            report['gpuMemory'] = sampler.facts()
        write_json(receipt, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--profile', default='zimage-bf16')
    parser.add_argument('--url', help='Explicit API base for an already deployed service, ending in /v1.')
    parser.add_argument('--infer', action='store_true', help='Submit one real request, save and probe its result. No automatic retry.')
    parser.add_argument('--timeout', type=int, default=240)
    args = parser.parse_args()
    try:
        result = verify(args.root.resolve(), load_profile(args.profile), infer=args.infer, url=args.url, timeout=args.timeout)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except DeploymentError as error:
        print(json.dumps(dict(status='failed', code=error.code, **error.facts), ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
