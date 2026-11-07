"""Isolated browser fixture API; never points at the user's projects or models.

PYTHONPATH=packages/core/src:apps/api/src python tests/browser/creation_server.py
"""
import argparse
import asyncio
from dataclasses import replace
from io import BytesIO
from pathlib import Path
import tempfile
import subprocess
import httpx

from fastapi import Request
from PIL import Image
import uvicorn

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app
from opendirector.application.tool_operations import TOOLS, Output
from opendirector.domain.capabilities import Segment, MediaResult
from opendirector.integrations.model_adapters import OpenAIImages, VllmOmniSegmentation
from opendirector.integrations.voice_library import VoiceLibrary


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=8019)
parser.add_argument('--root', type=Path)
parser.add_argument('--assistant-fixture', action='store_true', help='Use a gated assistant response without a real model')
args = parser.parse_args()
root = (args.root or Path(tempfile.mkdtemp(prefix='opendirector-creation-'))).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('opendirector-creation-'):
    parser.error('Browser fixtures require an opendirector-creation-* directory directly under the system temp directory')
store = LocalProjects(root)
configs = ModelConfigs(root)
if not configs.list():
    for kind in ('agent', 'image'):
        configs.save(kind, 'http://127.0.0.1:12345/v1', f'fixture-{kind}', '',
                     connection_type='self_hosted', protocol='openai', auth_mode='none')

# Test-only adapters let the real preview and tool services exercise owned
# assets, model selection and cancellation without contacting a GPU endpoint.
if not any(model['kind'] == 'vision' for model in configs.list()):
    configs.save('vision', 'http://127.0.0.1:12345/v1', 'facebook/sam3', '',
                 connection_type='self_hosted', protocol='vllm_omni', auth_mode='none')
if not any(model['modelId'] == 'Qwen/Qwen-Image-2.1' for model in configs.list()):
    configs.save('image', 'http://127.0.0.1:12345/v1', 'Qwen/Qwen-Image-2.1', '',
                 connection_type='self_hosted', protocol='openai', auth_mode='none')
if not any(model['modelId'] == 'fixture-tts' for model in configs.list()):
    configs.save('audio', 'http://127.0.0.1:12345/v1', 'fixture-tts', '',
                 connection_type='self_hosted', protocol='openai', auth_mode='none')
if not any(model['modelId'] == 'moss-tts-1.5-flash' for model in configs.list()):
    configs.save('audio', 'https://api.mosi.cn/v1', 'moss-tts-1.5-flash', 'fixture-moss-key',
                 connection_type='api', protocol='openai', auth_mode='bearer')
selection_gate = asyncio.Event()
selection_gate.set()
selection_calls, image_edit_calls = [], []
selection_active = 0


async def fixture_segment(self, config, request):
    global selection_active
    selection_calls.append(dict(concept=request.concept, boxes=request.boxes))
    selection_active += 1
    try:
        await selection_gate.wait()
        await asyncio.sleep(.01)
        with Image.open(BytesIO(request.image)) as image:
            width, height = image.size
        boxes = request.boxes or ((width * .05, height * .1, width * .45, height * .9),
                                  (width * .55, height * .1, width * .95, height * .9))
        results = []
        for box in boxes:
            box = tuple(round(value) for value in box)
            mask = Image.new('L', (width, height), 0)
            mask.paste(255, box)
            out = BytesIO()
            mask.save(out, 'PNG')
            results.append(Segment(out.getvalue(), box, .9))
        return results
    finally:
        selection_active -= 1


async def fixture_image_edit(self, config, request, **kwargs):
    image_edit_calls.append(dict(modelId=config['modelId'], references=len(request.references), prompt=request.prompt))
    out = BytesIO()
    Image.new('RGB', (request.width, request.height), 'red').save(out, 'PNG')
    return MediaResult(out.getvalue(), 'png')


VllmOmniSegmentation.segment = fixture_segment
OpenAIImages.image = fixture_image_edit


class FixtureProvider:
    def __init__(self):
        self.gate = asyncio.Event()
        self.gate.set()
        self.calls = []

    def validate(self, kind, config):
        if kind not in {'text', 'image', 'video', 'audio'}:
            raise ProjectError('Unsupported fixture generation kind')

    async def generate(self, config, task, submitted, *, result_ready=None):
        self.calls.append(dict(id=task['id'], kind=task['kind'], referenceIds=task['referenceIds'], parameters=task['parameters']))
        await self.gate.wait()
        await asyncio.sleep(.2)
        if task['kind'] == 'text':
            return 'md', ('Fixture generated: ' + task['prompt']).encode('utf-8')
        if task['kind'] == 'video':
            data = await asyncio.to_thread(lambda: subprocess.run(
                ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=10',
                 '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
                 '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], capture_output=True, check=True).stdout)
            return 'mp4', data
        if task['kind'] == 'audio':
            data = await asyncio.to_thread(lambda: subprocess.run(
                ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000',
                 '-t', '0.3', '-threads', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], capture_output=True, check=True).stdout)
            return 'wav', data
        image = BytesIO()
        size = tuple(map(int, task['parameters']['size'].split('x'))) if config['modelId'] == 'parameters-image' else (320, 240)
        Image.new('RGB', size, 'purple').save(image, 'PNG')
        return 'png', image.getvalue()


provider = FixtureProvider()
assistant_gate = asyncio.Event()
assistant_gate.set()
assistant_contexts = []
if args.assistant_fixture:
    from opendirector_api import agent

    async def fixture_agent(self, run):
        assistant_contexts.append(run.messages)
        yield {'type': 'delta', 'text': '已收到创作要求。'}
        await assistant_gate.wait()
        yield {'type': 'delta', 'text': '这是隔离测试回复。'}

    agent.AgentRuntimes.stream = fixture_agent
    agent.runtime_available = lambda runtime: runtime == 'default'
tool_gate = asyncio.Event()
tool_gate.set()
tool_calls = []
tool_outcome = 'succeeded'


async def fixture_outpaint(context):
    outcome = tool_outcome
    tool_calls.append(len(tool_calls) + 1)
    await context.progress('Fixture tool waiting')
    await tool_gate.wait()
    if outcome == 'failed':
        raise ProjectError('Fixture tool failed')
    outputs = []
    for color in (['purple', 'orange'] if outcome == 'multiple' else ['purple']):
        out = BytesIO()
        Image.new('RGB', (96, 64), color).save(out, 'PNG')
        outputs.append(Output('image', out.getvalue(), 'png', 'Fixture tool result ' + color))
    return outputs


# Only this isolated executable substitutes a recipe; no model endpoint is used.
TOOLS['outpaint'] = replace(TOOLS['outpaint'], requires=lambda _: (), recipe=fixture_outpaint)
fixture_vllm_voices = [
    {'name': 'narrator', 'created_at': 1738660000},
    {'name': 'clone-one', 'created_at': 1738660001,
     'ref_text': 'A calm sentence for the fixture.', 'speaker_description': 'warm narrator'},
]
fixture_moss_voices = [
    {'id': '11111111-2222-4333-8444-555555555555', 'object': 'audio.voice', 'name': 'MOSS Alice', 'created_at': 1710000000},
    {'id': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'object': 'audio.voice', 'name': 'MOSS Bob', 'created_at': 1710000001},
]


def fixture_voice_handler(request: httpx.Request):
    if request.url.host == 'api.mosi.cn':
        if request.method == 'GET':
            after = request.url.params.get('after')
            rows = fixture_moss_voices[1:] if after == 'moss-next' else fixture_moss_voices[:1]
            return httpx.Response(200, json={'object': 'list', 'data': rows,
                                             'has_more': not after,
                                             'next_cursor': None if after else 'moss-next'})
        if request.method == 'POST':
            return httpx.Response(201, json={'id': 'created-moss-voice', 'object': 'audio.voice',
                                             'name': 'Created MOSS voice', 'created_at': 1710000002})
    if request.url.host == '127.0.0.1':
        if request.method == 'GET':
            return httpx.Response(200, json={'voices': ['narrator', 'builtin-two'],
                                             'uploaded_voices': fixture_vllm_voices})
        if request.method == 'POST':
            created = {'name': 'created-clone', 'created_at': 1738660002,
                       'ref_text': 'Created fixture transcript', 'speaker_description': 'fixture'}
            fixture_vllm_voices[:] = [item for item in fixture_vllm_voices if item['name'] != created['name']]
            fixture_vllm_voices.append(created)
            return httpx.Response(201, json={'success': True, 'voice': created})
        if request.method == 'DELETE':
            name = request.url.path.rsplit('/', 1)[-1]
            fixture_vllm_voices[:] = [item for item in fixture_vllm_voices if item['name'] != name]
            return httpx.Response(204)
    return httpx.Response(404, json={'error': {'message': 'missing'}})


app = create_app(store, generation_provider=provider,
                 voice_library=VoiceLibrary(configs, httpx.MockTransport(fixture_voice_handler)))


@app.get('/api/creation-test-health')
def health():
    return dict(isolated=True, provider='fixture', root=str(root), calls=provider.calls, toolCalls=tool_calls,
                selectionCalls=selection_calls, selectionActive=selection_active, imageEditCalls=image_edit_calls,
                assistantFixture=args.assistant_fixture, assistantContexts=assistant_contexts,
                voiceConfigs=[item['modelId'] for item in configs.list() if item['kind'] == 'audio'])


@app.post('/api/creation-test-assistant-gate')
async def gate_assistant(request: Request):
    if (await request.json()).get('open') is True:
        assistant_gate.set()
    else:
        assistant_gate.clear()
    return dict(open=assistant_gate.is_set())


@app.post('/api/creation-test-legacy-projects')
async def legacy_fixture(request: Request):
    import json
    from opendirector.domain.projects import identifier, project_name
    value = await request.json()
    project_id, name = identifier(value['id']), project_name(value['name'])
    directory = root / 'projects' / name
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'project.json').write_text(json.dumps(dict(formatVersion=1, id=project_id, name=name)))
    (directory / 'conversation.json').write_text('{"version":1,"messages":[],"draft":"preserve"}')
    return dict(id=project_id, name=name, path=str(directory))


@app.post('/api/creation-test-gate')
async def gate(request: Request):
    value = await request.json()
    if value.get('open') is True:
        provider.gate.set()
    else:
        provider.gate.clear()
    return dict(open=provider.gate.is_set())


@app.post('/api/creation-test-selection-gate')
async def gate_selection(request: Request):
    if (await request.json()).get('open') is True:
        selection_gate.set()
    else:
        selection_gate.clear()
    return dict(open=selection_gate.is_set())


@app.post('/api/creation-test-tool-gate')
async def gate_tool(request: Request):
    global tool_outcome
    value = await request.json()
    if value.get('outcome') in {'succeeded', 'failed', 'multiple'}:
        tool_outcome = value['outcome']
    if value.get('open') is True:
        tool_gate.set()
    else:
        tool_gate.clear()
    return dict(open=tool_gate.is_set())


print('Isolated browser fixture root:', root, flush=True)
uvicorn.run(app, host='127.0.0.1', port=args.port)
