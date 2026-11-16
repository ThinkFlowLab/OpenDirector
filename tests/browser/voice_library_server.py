"""Isolated UI fixture using real voice services with mocked provider HTTP.

Run like creation_server.py. No GPU or MOSS account is contacted. Uploads still
pass real ffprobe validation, and generation still validates the voice registry.
"""
import io
import json
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
import runpy
import wave

import httpx
import uvicorn
from opendirector.application.voice_library import VoiceLibrary

stream = io.BytesIO()
with wave.open(stream, 'wb') as audio:
    audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
    audio.writeframes(b'\0\0' * 32000)
sample = stream.getvalue()
uploads = {}
calls = []


def provider(request):
    calls.append(dict(method=request.method, url=str(request.url)))
    if request.url.host == 'api.minimax.cn':
        assert request.method == 'POST' and request.url.path == '/v1/get_voice'
        assert json.loads(request.content) == {'voice_type': 'system'}
        return httpx.Response(200, json={'base_resp': {'status_code': 0}, 'system_voice': [
            {'voice_id': 'Chinese (Mandarin)_Reliable_Executive', 'voice_name': 'Narrator'},
            {'voice_id': 'Santa_Claus ', 'voice_name': 'Santa Claus'},
        ]})
    cloud = request.url.host == 'api.mosi.cn'
    boundary = request.url.host
    records = uploads.setdefault(boundary, {})
    if request.url.path == '/preview.wav':
        return httpx.Response(200, content=sample, headers={'Content-Type': 'audio/wav'})
    if request.method == 'GET':
        if cloud:
            if request.url.params.get('after') or request.url.params.get('cursor'):
                return httpx.Response(200, json={'data': list(records.values()), 'has_more': False})
            return httpx.Response(200, json={'data': [{'id': 'cloud-built-in', 'name': 'Cloud voice'}], 'has_more': bool(records), 'next_cursor': 'cloud-built-in' if records else None})
        return httpx.Response(200, json={'voices': ['default', 'Alice'], 'uploaded_voices': ([
            {'id': 'sample', 'name': 'Sample voice', 'embedding_source': 'audio', 'ref_text': 'Hello world.',
             'preview_url': 'http://voice.test/preview.wav', 'language': 'English', 'gender': 'Female'}] if boundary == 'voice.test' else []) + list(records.values())})
    if request.method == 'POST':
        message = BytesParser(policy=default).parsebytes(b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + request.read())
        parts = {part.get_param('name', header='content-disposition'): part for part in message.iter_parts()}
        fields = {key: part.get_payload(decode=True) for key, part in parts.items()}
        sample_headers = {
            ('sample.wav', 'audio/wav'): b'RIFF',
            ('sample.webm', 'audio/webm'): bytes.fromhex('1a45dfa3'),  # EBML header
        }
        audio = parts['audio_sample']
        assert fields['audio_sample'].startswith(sample_headers[audio.get_filename(), audio.get_content_type()])
        name = fields['name'].decode()
        if cloud:
            assert 'consent' not in fields
        else:
            assert fields['consent'] == b'consent-fixture-01'
        identity = 'cloud-' + name if cloud else name.strip().lower()
        record = {'id': identity, 'name': name, 'embedding_source': 'audio', 'ref_text': fields.get('ref_text', b'').decode()}
        records[identity] = record
        if cloud:
            return httpx.Response(200, json=record)
        # The documented upload response may omit the canonical id returned by the list.
        return httpx.Response(200, json={'success': True, 'voice': {k: v for k, v in record.items() if k != 'id'}})
    if request.method == 'DELETE':
        records.pop(request.url.path.rsplit('/', 1)[-1], None)
        return httpx.Response(200, json={'success': True})
    return httpx.Response(405)


original_init = VoiceLibrary.__init__
def init(self, configs, transport=None):
    original_init(self, configs, transport=httpx.MockTransport(provider))
VoiceLibrary.__init__ = init
original_run = uvicorn.run

def run(app, **kwargs):
    @app.get('/api/voice-test-health')
    def health():
        return {'isolated': True, 'calls': calls, 'provider': 'httpx-mock', 'records': uploads}
    original_run(app, **kwargs)
uvicorn.run = run
runpy.run_path(str(Path(__file__).with_name('creation_server.py')), run_name='__main__')
