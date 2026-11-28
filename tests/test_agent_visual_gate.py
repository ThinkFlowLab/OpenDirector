"""The model must receive pixels from the native reader, including an extracted frame."""
import asyncio
from contextlib import aclosing
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
from PIL import Image, ImageDraw
import pytest

from opendirector.agent import native
from opendirector.agent.runtime import AgentRuntimes, RUNTIMES, installation
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.chat_completions import ChatCompletions
from opendirector_api.main import create_app
from test_native_runtime import real_opencode_worker
from visual_model_fixture import anthropic_stream, image_bytes, latest_tool_output, responses_stream, serve_model


pytestmark = pytest.mark.cpu


COLORS = {'red': (240, 20, 20), 'blue': (20, 20, 240),
          'green': (20, 200, 20), 'yellow': (240, 240, 20)}
STILL = ('red', 'blue')
FRAME = ('yellow', 'green')


def make_media(directory):
    def draw(path, colors):
        image = Image.new('RGB', (64, 48), COLORS[colors[0]])
        ImageDraw.Draw(image).rectangle((32, 0, 63, 47), fill=COLORS[colors[1]])
        image.save(path)

    still = directory / 'still.png'
    second = directory / 'second.png'
    clip = directory / 'source.mp4'
    draw(still, STILL)
    draw(second, FRAME)
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-loop', '1', '-t', '1', '-i', str(still),
        '-loop', '1', '-t', '1', '-i', str(second), '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0,fps=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        str(clip)], check=True, timeout=20)
    return still, clip


def prepare_project(client, still, clip):
    pid = str(uuid4())
    base = f'/api/creation/projects/{pid}'
    response = client.post(base + '/commands', json=dict(type='project.create', projectId=pid,
        commandId=str(uuid4()), payload={'name': 'Visual input gate'}))
    assert response.is_success
    assert client.post(base + '/open').is_success
    assets = {}
    for path, kind in ((still, 'image'), (clip, 'video')):
        handle = str(uuid4())
        response = client.put(f'{base}/uploads/{handle}', content=path.read_bytes(),
            headers={'X-Asset-Name': path.name})
        assert response.is_success
        response = client.post(base + '/commands', json=dict(type='asset.import', projectId=pid,
            commandId=str(uuid4()), payload=dict(uploadHandle=handle, name=path.name, expectedKind=kind)))
        assert response.is_success
        assets[kind] = response.json()['changed'][0]['id']
    return base, assets


def shell_extract(source, output):
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
            '-ss', '1.5', '-i', str(source), '-frames:v', '1', '-threads:v', '1', str(output)]
    return subprocess.list2cmdline(args) if os.name == 'nt' else shlex.join(args)


def chunk_response(call=None, text='Visual input received.'):
    delta = {'tool_calls': [{'index': 0, 'id': f'call-{call[0]}', 'type': 'function',
        'function': {'name': call[1], 'arguments': json.dumps(call[2])}}]} if call else {'content': text}
    chunk = dict(id='vision-fixture', object='chat.completion.chunk', created=1, model='vision-fixture')
    body = [dict(chunk, choices=[dict(index=0, delta=delta, finish_reason=None)]),
        dict(chunk, choices=[dict(index=0, delta={}, finish_reason='tool_calls' if call else 'stop')])]
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=(
        ''.join(f'data: {json.dumps(part)}\n\n' for part in body) + 'data: [DONE]\n\n').encode())


def transmitted_pixels(messages):
    colors = []
    for png in image_bytes(messages):
        with Image.open(BytesIO(png)) as image:
            colors.append(half_colors(image))
    return colors


def half_colors(image):
    rgb = image.convert('RGB')
    def closest(x):
        pixel = rgb.getpixel((rgb.width * x // 4, rgb.height // 2))
        return min(COLORS, key=lambda color: sum((actual - expected) ** 2
                                               for actual, expected in zip(pixel, COLORS[color])))
    return closest(1), closest(3)


def run_turn(client, base, **turn):
    response = client.post(base + '/assistant/turns', json={'id': str(uuid4()), **turn})
    assert response.is_success, response.status_code
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert events and events[-1]['type'] == 'end' and events[-1]['error'] is None, (
        events[-1].get('error') if events else 'missing turn events')
    return events[-1]['conversation']['messages'][-1]['text']


@pytest.fixture
def bounded_runtime(monkeypatch):
    stream = AgentRuntimes.stream

    async def bounded_stream(self, run):
        async with asyncio.timeout(150), aclosing(stream(self, run)) as events:
            async for event in events:
                yield event

    monkeypatch.setattr(AgentRuntimes, 'stream', bounded_stream)


def configure_fixture_runtime(runtime, directory, origin, monkeypatch):
    """Point the real CLI at a local provider and give it fresh native state."""
    for name in ('NO_PROXY', 'no_proxy'):
        monkeypatch.setenv(name, '127.0.0.1,localhost')
    if runtime == 'deepseek':
        monkeypatch.setenv('DSH_HOME', str(directory / 'dsh'))
        monkeypatch.setenv('DEEPSEEK_BASE_URL', origin)
        monkeypatch.setenv('DEEPSEEK_API_KEY', 'local-fixture')
        return {}
    if runtime == 'claude':
        monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(directory / 'claude'))
        monkeypatch.setenv('ANTHROPIC_BASE_URL', origin)
        monkeypatch.setenv('ANTHROPIC_API_KEY', 'local-fixture')
        for name in ('ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
        return {'runtimeModel': 'claude-sonnet-4-5'}
    if runtime == 'codex':
        config = directory / 'codex'
        config.mkdir()
        monkeypatch.setenv('CODEX_HOME', str(config))
        monkeypatch.setenv('OPENDIRECTOR_VISUAL_FIXTURE_KEY', 'local-fixture')
        command = native.command

        def command_with_loopback_provider(*args, **kwargs):
            argv, env = command(*args, **kwargs)
            # The production command ignores CODEX_HOME/config.toml. Route
            # the real executable explicitly while keeping that isolation.
            return argv + ['-c', 'model_provider="visual_fixture"',
                '-c', 'model_providers.visual_fixture.name="Visual fixture"',
                '-c', 'model_providers.visual_fixture.base_url=' + json.dumps(origin + '/v1'),
                '-c', 'model_providers.visual_fixture.env_key="OPENDIRECTOR_VISUAL_FIXTURE_KEY"',
                '-c', 'model_providers.visual_fixture.wire_api="responses"',
                '-c', 'model_providers.visual_fixture.supports_websockets=false'], env

        monkeypatch.setattr(native, 'command', command_with_loopback_provider)
        return {'runtimeModel': 'gpt-5.4'}
    if runtime == 'opencode':
        for name in ('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'):
            monkeypatch.setenv(name, str(directory / name.lower()))
        monkeypatch.setenv('OPENCODE_DISABLE_MODELS_FETCH', 'true')
        config = directory / 'xdg_config_home' / 'opencode'
        config.mkdir(parents=True)
        (config / 'opencode.json').write_text(json.dumps({
            'model': 'local/vision-fixture', 'small_model': 'local/vision-fixture',
            'provider': {'local': {'npm': '@ai-sdk/openai-compatible', 'name': 'Visual fixture',
                'options': {'baseURL': origin + '/v1', 'apiKey': 'local-fixture'},
                'models': {'vision-fixture': {'name': 'Fixture',
                    'modalities': {'input': ['text', 'image'], 'output': ['text']}}}}},
        }), encoding='utf-8')
        return {'runtimeModel': 'local/vision-fixture'}
    assert runtime == 'jiuwenswarm'
    home = directory / 'swarm'
    config = home / 'config'
    config.mkdir(parents=True)
    monkeypatch.setenv('JIUWENSWARM_DATA_DIR', str(home))
    monkeypatch.setenv('JIUWENSWARM_CONFIG_DIR', str(config))
    (config / 'config.yaml').write_text(json.dumps({
        'preferred_language': 'en', 'progressive_tool_enabled': False,
        'rsi': {'enabled': False}, 'auto_recap': {'enabled': False},
        'models': {'defaults': [{'model_id': 'fixture', 'is_default': True,
            'model_client_config': {'api_base': origin + '/v1', 'api_key': 'local-fixture',
                'model_name': 'vision-fixture', 'client_provider': 'OpenAI', 'supports_vision': True},
            'model_config_obj': {}}]},
    }), encoding='utf-8')
    return {'runtimeModel': 'vision-fixture#0'}


def visual_steps(runtime, source_still, source_clip, work):
    reader, path_field = {
        'opencode': ('read', 'filePath'), 'codex': ('view_image', 'path'),
        'claude': ('Read', 'file_path'), 'deepseek': ('read_image', 'file_path'),
        'jiuwenswarm': ('read_file', 'file_path'),
    }[runtime]
    shell = {'codex': 'exec_command', 'claude': 'Bash'}.get(runtime, 'bash')
    def command(args):
        return shell, {'cmd' if runtime == 'codex' else 'command': args, 'description': 'Prepare an inspection frame'}
    output = work / 'gate-frame.png'
    steps = []
    if runtime == 'jiuwenswarm':
        # Jiuwen's read_file requires an image suffix. The project blob has none.
        still = work / 'gate-still.png'
        convert = ['ffmpeg', '-v', 'error', '-nostdin', '-i', str(source_still), '-frames:v', '1', str(still)]
        steps.append(([], command(shlex.join(convert))))
        source_still = still
    steps.extend([
        ([], (reader, {path_field: str(source_still)})),
        ([STILL], command(shell_extract(source_clip, output))),
        ([STILL], (reader, {path_field: str(output)})),
        ([STILL, FRAME], None),
    ])
    return steps


@pytest.mark.merge
@pytest.mark.skipif(os.getenv('OPENDIRECTOR_HARNESS_CI') != '1',
                    reason='run with the five pinned Harness CLIs installed')
# pi is left out until release CI provisions a provider for it; the five pinned
# CLIs are installed without credentials of their own.
@pytest.mark.parametrize('runtime', [name for name in RUNTIMES if name not in ('default', 'pi')])
def test_harness_native_visual_input(runtime, tmp_path, monkeypatch, bounded_runtime):
    assert installation(runtime), f'Missing CLI for {runtime}'
    still, clip = make_media(tmp_path)
    local = LocalProjects(tmp_path / 'app')
    reply = 'Both images reached the model.'
    turn = str(uuid4())
    stage = 0
    failures = []
    steps = []

    def model(path, payload):
        nonlocal stage
        if path.partition('?')[0].endswith('/count_tokens'):
            return 200, 'application/json', b'{"input_tokens": 10}'
        protocol = path.partition('?')[0].split('/')[-1]
        tool_names = {item.get('name') or item.get('function', {}).get('name') for item in payload.get('tools', [])}
        call = None
        if tool_names:
            try:
                assert stage < len(steps), 'Unexpected additional tool-enabled request'
                if stage == 0:
                    serialized = json.dumps(payload)
                    assert 'Referenced project assets:' in serialized
                    assert all(asset_id in serialized for asset_id in assets.values())
                expected, call = steps[stage]
                visual_input = payload['input'] if protocol == 'responses' else payload['messages']
                if call and str(frame) in call[1].values():
                    assert frame.is_file(), 'FFmpeg output missing. Native tool result: ' + latest_tool_output(visual_input)
                actual = transmitted_pixels(visual_input)
                assert actual == expected, f'{runtime} request {stage}: pixels {actual}, expected {expected}'
                if call is not None:
                    assert call[0] in tool_names, f'Missing {call[0]} in {sorted(n for n in tool_names if n)}'
                stage += 1
            except (AssertionError, KeyError, ValueError) as error:
                failures.append(str(error))
                return 400, 'application/json', b'{"error":{"message":"Visual fixture contract failed","type":"invalid_request_error"}}'

        if protocol == 'messages':
            body = anthropic_stream(stage, call, reply, payload['model'])
        elif protocol == 'responses':
            body = responses_stream(stage, call, reply, payload['model'])
        else:
            assert protocol == 'completions'
            if not payload.get('stream') and not call:
                body = json.dumps(dict(id='side', model='fixture', object='chat.completion', created=1,
                    choices=[dict(index=0, message={'role':'assistant','content':reply}, finish_reason='stop')])).encode()
                return 200, 'application/json', body
            body = chunk_response((stage, *call) if call else None, text=reply).content
        return 200, 'text/event-stream', body

    with serve_model(model) as origin:
        selection = configure_fixture_runtime(runtime, tmp_path, origin, monkeypatch)
        with TestClient(create_app(local), headers={
                'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
            base, assets = prepare_project(client, still, clip)
            directory = local.root / 'Visual input gate'
            work = directory / 'agent-runs' / turn / 'work'
            frame = work / 'gate-frame.png'
            paths = {asset['kind']: directory / asset['path'] for asset in client.get(base).json()['assets']}
            steps = visual_steps(runtime, paths['image'], paths['video'], work)
            try:
                observed = run_turn(client, base, runtime=runtime, id=turn, **selection,
                    assets=list(assets.values()), text='Inspect the still and one extracted frame with native tools.')
            finally:
                assert not failures, failures
            assert observed == reply
            assert stage == len(steps)
            with Image.open(frame) as image:
                assert half_colors(image) == FRAME
            snapshot = client.get(base).json()
            assert {item['id'] for item in snapshot['assets']} == set(assets.values())
            assert snapshot['jobs'] == []


@pytest.mark.merge
@pytest.mark.parametrize('vision', [True, False], ids=['image-model', 'text-only-model'])
def test_real_opencode_native_visual_input(vision, tmp_path, real_opencode_worker):
    if not real_opencode_worker:
        return
    still, clip = make_media(tmp_path)
    local = LocalProjects(tmp_path / 'app')
    config = ModelConfigs(local.repository).save('agent', 'http://test.invalid/v1',
        'vision-fixture', 'server-only-key', input_modalities=['text', 'image'] if vision else ['text'])
    requests = []
    expected = [[], [STILL], [STILL], [STILL, FRAME]] if vision else [[], []]
    reply_text = 'Visual input received.' if vision else 'The selected model does not accept image input.'

    def model(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert request.headers['authorization'] == 'Bearer server-only-key'
        index = len(requests) - 1
        assert transmitted_pixels(payload['messages']) == expected[index]
        tools = {item['function']['name'] for item in payload['tools']}
        context = next(message['content'] for message in payload['messages']
                       if isinstance(message['content'], str) and 'Referenced project assets: ' in message['content'])
        current_user = json.loads(context.splitlines()[-1])[-1]['content']
        refs = json.loads(current_user.split('Referenced project assets: ', 1)[1].splitlines()[0])
        source = {item['kind']: item['path'] for item in refs}
        work = Path(context.split('Execution directory: ', 1)[1].splitlines()[0])
        frame = work / 'frame.png'
        choices = [
            ('read', {'filePath': source['image']}),
            ('bash', {'command': shell_extract(source['video'], frame), 'description': 'Extract a local video frame'}),
            ('read', {'filePath': str(frame)}),
        ] if vision else [('read', {'filePath': source['image']})]
        if index == len(choices):
            return chunk_response(text=reply_text)
        name, args = choices[index]
        assert name in tools
        return chunk_response((index, name, args))

    provider = ChatCompletions(httpx.MockTransport(model))
    with TestClient(create_app(local, chat_provider=provider), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        base, assets = prepare_project(client, still, clip)
        reply = run_turn(client, base, runtime='default', modelId=config['id'],
            assets=list(assets.values()), text='Read the image and one extracted video frame.')
        assert reply == reply_text
        assert len(requests) == len(expected)
        snapshot = client.get(base).json()
        assert {item['id'] for item in snapshot['assets']} == set(assets.values())
        assert snapshot['jobs'] == []


def configured_runtime(runtime):
    requested = {name.strip() for name in os.getenv('OPENDIRECTOR_VISUAL_GATE', '').split(',')} - {''}
    assert requested <= set(RUNTIMES) | {'all'}, 'Unknown runtime in OPENDIRECTOR_VISUAL_GATE'
    if 'all' not in requested and runtime not in requested:
        pytest.skip('Opt in by naming this runtime in OPENDIRECTOR_VISUAL_GATE')
    assert installation(runtime), f'The requested runtime {runtime} is not installed'
    if runtime == 'default':
        values = [os.getenv(f'OPENDIRECTOR_VISUAL_GATE_{key}') for key in ('URL', 'MODEL', 'KEY')]
        assert all(values[:2]), 'Configure OPENDIRECTOR_VISUAL_GATE_URL and OPENDIRECTOR_VISUAL_GATE_MODEL'
        return values
    return os.getenv(f'OPENDIRECTOR_VISUAL_GATE_{runtime.upper()}_MODEL')


@pytest.mark.nightly
@pytest.mark.parametrize('runtime', tuple(RUNTIMES))
def test_live_runtime_visual_input(runtime, tmp_path, bounded_runtime, request):
    model = configured_runtime(runtime)
    local = LocalProjects(tmp_path / 'app')
    turn = {'runtime': runtime}
    if runtime == 'default':
        url, model_id, key = model
        configs = ModelConfigs(local.repository)
        config = configs.save('agent', url, model_id, key or '',
            auth_mode='bearer' if key else 'none', input_modalities=['text', 'image'])
        request.addfinalizer(lambda: configs.delete(config['id']))
        turn['modelId'] = config['id']
    elif model:
        turn['runtimeModel'] = model
    still, clip = make_media(tmp_path)
    with TestClient(create_app(local), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        base, assets = prepare_project(client, still, clip)
        reply = run_turn(client, base, **turn, assets=list(assets.values()), text=(
            'Visual smoke test. Read the referenced still with your native image-reading tool. '
            'Use local FFmpeg to extract a frame at 1.5 seconds from the referenced video to gate-frame.png in the execution directory, '
            'and read that frame with the same tool. Look at the left and right halves of each image. '
            'Return exactly two plain lines: STILL=<left color>,<right color> and FRAME=<left color>,<right color>. '
            'Report any inability to inspect either image.'))
        pattern = r'still\s*=\s*(\w+),\s*(\w+)\s+frame\s*=\s*(\w+),\s*(\w+)'
        results = re.findall(pattern, reply.lower())
        assert results and results[-1] == STILL + FRAME, f'{runtime} did not read both images correctly'
        frame, = local.root.glob('*/agent-runs/*/work/gate-frame.png')
        with Image.open(frame) as image:
            assert half_colors(image) == FRAME
        snapshot = client.get(base).json()
        assert {item['id'] for item in snapshot['assets']} == set(assets.values())
        assert snapshot['jobs'] == []
