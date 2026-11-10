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
import unicodedata
from uuid import uuid4

if __package__:
    from .deploy import (DeploymentError, capture, load_profile, profile_digest, read_json,
                         readiness, request_bytes, request_json, write_json)
else:
    from deploy import (DeploymentError, capture, load_profile, profile_digest, read_json,
                        readiness, request_bytes, request_json, write_json)


MAX_AUDIO_BYTES = 25 * 1024 ** 2
AUDIO_TYPES = {'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
               '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.mp4': 'audio/mp4'}


def read_audio(path):
    if path is None:
        raise DeploymentError('audio_input_required')
    path = Path(path)
    if path.suffix.lower() not in AUDIO_TYPES:
        raise DeploymentError('unsupported_audio_format')
    try:
        with path.open('rb') as stream:
            raw = stream.read(MAX_AUDIO_BYTES + 1)
    except OSError:
        raise DeploymentError('audio_input_unreadable') from None
    if not raw or len(raw) > MAX_AUDIO_BYTES:
        raise DeploymentError('invalid_audio_input_size', limitBytes=MAX_AUDIO_BYTES)
    return raw, path.suffix.lower()


def request_transcription(url, payload, audio, suffix, timeout):
    """One standard multipart request to the upstream ASR endpoint; no retry."""
    boundary = 'opendirector-' + uuid4().hex
    parts = []
    for key, value in payload.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="input{suffix}"\r\n'
                  f'Content-Type: {AUDIO_TYPES[suffix]}\r\n\r\n'.encode(), audio,
                  f'\r\n--{boundary}--\r\n'.encode()])
    return request_bytes(url, b''.join(parts), 'multipart/form-data; boundary=' + boundary, timeout)


def compare_text(actual, expected):
    """Character error rate after NFKC, case folding and punctuation/space removal.

    This reproducible content check is not a listening or pronunciation score.
    """
    def normalize(value):
        return ''.join(c for c in unicodedata.normalize('NFKC', value).casefold() if c.isalnum())
    reference, hypothesis = normalize(expected), normalize(actual)
    if not reference or max(len(reference), len(hypothesis)) > 4096:
        raise DeploymentError('invalid_comparison_text', limitCharacters=4096)
    row = list(range(len(reference) + 1))
    for i, char in enumerate(hypothesis, 1):
        current = [i]
        for j, other in enumerate(reference, 1):
            current.append(min(current[-1] + 1, row[j] + 1, row[j - 1] + (char != other)))
        row = current
    return dict(normalization='NFKC_casefold_alphanumeric', referenceCharacters=len(reference),
                editDistance=row[-1], characterErrorRate=row[-1] / len(reference), exactMatch=reference == hypothesis)


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


def verify(root, profile, *, infer=False, url=None, timeout=240, audio_file=None, expected_text=None):
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
    kind = profile['verification']['kind']
    audio, suffix = read_audio(audio_file) if kind == 'transcription' else (None, None)
    if expected_text is not None:
        if kind != 'transcription':
            raise DeploymentError('comparison_requires_transcription')
        compare_text('', expected_text)
    directory = root / 'outputs' / report['runId']
    directory.mkdir(parents=True)
    receipt = directory / 'verification.json'
    payload = dict(profile['verification']['request'], model=profile['modelId'])
    report.update(status='preparing_input', request=payload)
    write_json(receipt, report)
    sampler = GpuSampler(state['gpuUuid']) if state else None
    sampled = False
    started = time.monotonic()
    try:
        if kind == 'transcription':
            source = directory / ('input' + suffix)
            source.write_bytes(audio)
            report['input'] = dict(artifact=str(source), artifactSha256=hashlib.sha256(audio).hexdigest(),
                                   bytes=len(audio), media=media_facts(source, 'audio', None))
        report['status'] = 'submission_started'
        write_json(receipt, report)
        if sampler:
            sampler.__enter__()
            sampled = True
        raw = (request_transcription(url + profile['verification']['path'], payload, audio, suffix, timeout)
               if kind == 'transcription' else request_json(url + profile['verification']['path'], payload, timeout))
        elapsed = time.monotonic() - started
        if kind == 'image':
            raw = base64.b64decode(json.loads(raw)['data'][0]['b64_json'], validate=True)
        path = directory / {'image': 'result.png', 'audio': 'result.mp3', 'transcription': 'result.json'}[kind]
        with path.open('xb') as out:
            out.write(raw)
        if kind == 'transcription':
            text = json.loads(raw)['text']
            if not isinstance(text, str) or not text.strip():
                raise DeploymentError('invalid_provider_output')
            report['transcript'] = text
            facts = dict(characters=len(text))
            if expected_text is not None:
                report['textComparison'] = dict(referenceText=expected_text, **compare_text(text, expected_text))
        else:
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
        if sampled:
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
    parser.add_argument('--audio-file', type=Path, help='ASR input, at most 25 MiB. Required only for transcription --infer.')
    parser.add_argument('--expected-text', help='Optional reference for a character error measurement; never sent to the model.')
    args = parser.parse_args()
    try:
        result = verify(args.root.resolve(), load_profile(args.profile), infer=args.infer, url=args.url, timeout=args.timeout,
                        audio_file=args.audio_file, expected_text=args.expected_text)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except DeploymentError as error:
        print(json.dumps(dict(status='failed', code=error.code, **error.facts), ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
