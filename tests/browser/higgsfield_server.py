"""Isolated MAGI-2 browser fixture using the actual adapter and mocked HTTP."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

from fastapi.responses import Response
import httpx
from PIL import Image
import uvicorn

from opendirector.application import creation_generation
from opendirector.domain.higgsfield import BASE
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.main import create_app


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=8504)
parser.add_argument('--root', type=Path)
args = parser.parse_args()
root = (args.root or Path(tempfile.mkdtemp(prefix='opendirector-magi2-'))).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('opendirector-magi2-'):
    parser.error('Use an opendirector-magi2-* directory directly under the system temp directory')


def ffmpeg(*arguments):
    return subprocess.run(['ffmpeg', '-v', 'error', *arguments, 'pipe:1'], check=True, capture_output=True).stdout


video = ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24', '-t', '4', '-c:v', 'libx264', '-threads', '1',
               '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4')
audio = ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '2', '-f', 'wav')
mp3 = ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '2', '-f', 'mp3')
image = BytesIO()
Image.new('RGB', (320, 180), '#516a8e').save(image, 'PNG')
calls, jobs = [], {}


def cloud(request):
    path = request.url.path
    if request.url.host == '93.184.216.34':
        assert 'authorization' not in request.headers
        calls.append(dict(method=request.method, path=path, size=len(request.content)))
        return httpx.Response(200, content=video if request.method == 'GET' else b'')
    assert request.url.host == 'api.higgsfield.ai'
    assert request.headers['authorization'] == 'Key fixture-id:fixture-secret'
    if path == '/files/generate-upload-url':
        identity = str(uuid4())
        return httpx.Response(200, json=dict(upload_url=f'https://93.184.216.34/upload/{identity}',
            public_url=f'https://93.184.216.34/input/{identity}', upload_headers={}))
    if request.method == 'POST' and path.startswith('/sand/magi-2/'):
        key = request.headers['Idempotency-Key']
        payload = json.loads(request.content)
        calls.append(dict(method='POST', path=path, key=key, payload=payload))
        jobs.setdefault(key, dict(request_id=key, status='queued',
            status_url=f'{BASE}/returned/status/{key}', cancel_url=f'{BASE}/returned/cancel/{key}'))
        return httpx.Response(202, json=jobs[key])
    if request.method == 'GET' and path.startswith('/returned/status/'):
        identity = path.rsplit('/', 1)[-1]
        return httpx.Response(200, json=dict(request_id=identity, status='completed', video={'url': 'https://93.184.216.34/result.mp4'}))
    raise AssertionError(f'Unexpected fixture request: {request.method} {path}')


class FixtureGeneration(GenerationProviders):
    def __init__(self, store):
        super().__init__(store, httpx.MockTransport(cloud), poll_interval=.01)

    def validate(self, kind, config):
        if config.get('protocol') != 'higgsfield_open':
            raise ProjectError('This isolated fixture only supports MAGI-2')
        super().validate(kind, config)


creation_generation.GenerationProviders = FixtureGeneration
app = create_app(LocalProjects(root))


@app.get('/api/magi2-test-health')
async def health():
    return dict(isolated=True, provider='higgsfield-mock-http', calls=calls)


@app.get('/api/magi2-test-media/{name}')
async def media(name: str):
    data, mime = {'image.png': (image.getvalue(), 'image/png'), 'video.mp4': (video, 'video/mp4'),
                  'audio.wav': (audio, 'audio/wav'), 'unsupported.mp3': (mp3, 'audio/mpeg')}[name]
    return Response(data, media_type=mime)


print(f'Isolated MAGI-2 browser fixture root: {root}', flush=True)
uvicorn.run(app, host='127.0.0.1', port=args.port)
