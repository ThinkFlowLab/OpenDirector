"""Real assistant admission, CLI, tool dispatch and persistence with a scripted ACP peer."""
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app
from process_helpers import python_cli


ACP_PEER = r'''
import json, os, subprocess, sys
from pathlib import Path
from uuid import uuid4

def send(**record):
    print(json.dumps(dict(jsonrpc='2.0', **record)), flush=True)

def cli(*args, payload=None):
    result = subprocess.run(['opendirector', *args], text=True,
                            input=json.dumps(payload) if payload is not None else None,
                            capture_output=True, timeout=30)
    assert result.returncode == 0, (result.stdout, result.stderr)
    return json.loads(result.stdout)

for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    if method == 'initialize':
        result = {'protocolVersion': 1}
    elif method in {'session/new', 'session/resume'}:
        result = {'sessionId': 'source-reference-test', 'configOptions': []}
    elif method == 'session/close':
        send(id=request['id'], result={})
        break
    elif method == 'session/prompt':
        user = request['params']['prompt'][-1]['text']
        project = cli('project', 'show')
        refs = project['turnReferences']
        pid = project['project']['id']
        if 'Generate an image' in user:
            model = os.environ['SOURCE_TEST_IMAGE_MODEL']
            spec_id, item_id = str(uuid4()), str(uuid4())
            spec = dict(id=spec_id, projectId=pid, kind='image', purpose='generation',
                        prompt='Draw the supplied color.', modelConfigId=model)
            item = dict(id=item_id, projectId=pid, kind='image',
                        binding=dict(role='generation', objectRef=dict(id=spec_id)))
            flags = [argument for ref in refs for argument in ('--turn-reference', ref['id'])]
            plan = cli('canvas', 'create-generation', '--file', '-', *flags,
                       payload={'payload': {'spec': spec, 'item': item}})
            assert plan['status'] == 'applied'
            asset = refs[0]['asset']
            cli('asset', 'update-metadata', '--asset-id', asset['assetId'], '--name', 'Renamed portrait.png',
                '--expected-version', f"asset:{asset['assetId']}:{asset['revision']}")
            versions = [row for row in plan['changed'] if row['id'] in {spec_id, item_id}]
            submit = cli('generation', 'submit', '--file', '-', payload={
                'payload': {'specId': spec_id, 'expectedSpecRevision': 1, 'originItemId': item_id},
                'expectedVersions': versions})
            assert submit['status'] == 'accepted'
            cli('job', 'wait', submit['jobIds'][0], '--timeout', '15')
            reply = 'Done.'
        elif 'Plan a video trim' in user:
            Path('trim-plan.json').write_text(json.dumps(refs[0]), encoding='utf-8')
            reply = 'Ready to trim the selected source.'
        else:
            assert 'Trim the selected video' in user
            planned = json.loads(Path('trim-plan.json').read_text(encoding='utf-8'))
            trim = cli('video', 'trim', '--turn-reference', planned['id'],
                       '--start', '1.2', '--end', '1.7', '--name', 'Trimmed clip.mp4')
            assert trim['status'] == 'applied'
            reply = 'Done.'
        send(method='session/update', params=dict(sessionId='source-reference-test',
             update=dict(sessionUpdate='agent_message_chunk', content=dict(type='text', text=reply))))
        result = {'stopReason': 'end_turn'}
    else:
        continue
    send(id=request['id'], result=result)
'''


def png(color):
    data = BytesIO()
    Image.new('RGB', (64, 48), color).save(data, 'PNG')
    return data.getvalue()


class ImageProvider:
    def __init__(self):
        self.calls = []

    def validate(self, kind, config):
        assert kind == 'image'

    async def generate(self, config, task, submitted):
        self.calls.append(task['referenceIds'])
        return 'png', png('green')


@pytest.fixture
def project(tmp_path, monkeypatch):
    python_cli(tmp_path / 'dsh', ACP_PEER)
    monkeypatch.setenv('PATH', str(tmp_path) + os.pathsep + os.environ['PATH'])
    root = Path(__file__).resolve().parents[1]
    monkeypatch.setenv('PYTHONPATH', os.pathsep.join(str(root / path) for path in ('packages/core/src', 'apps/api/src')))
    local = LocalProjects(tmp_path / 'app')
    model = ModelConfigs(local.repository).save('image', 'http://localhost:5567/v1',
        'gpt-image-1', '', connection_type='self_hosted', protocol='openai', auth_mode='none',
        capability_auto_check=False)
    monkeypatch.setenv('SOURCE_TEST_IMAGE_MODEL', model['id'])
    provider = ImageProvider()
    pid = str(uuid4())
    base = f'/api/creation/projects/{pid}'
    with TestClient(create_app(local, generation_provider=provider), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4()), 'Accept-Language': 'en-US',
    }) as client:
        command(client, base, 'project.create', {'name': 'Source reference acceptance'})
        assert client.post(base + '/open').is_success
        yield client, base, provider


def command(client, base, kind, payload, *, versions=()):
    response = client.post(base + '/commands', json=dict(type=kind, payload=payload,
        projectId=base.split('/')[-1], commandId=str(uuid4()), expectedVersions=list(versions)))
    assert response.is_success, response.text
    receipt = response.json()
    assert receipt['status'] == 'applied', receipt
    return receipt


def source_nodes(client, base, name, kind, data):
    handle = str(uuid4())
    upload = client.put(f'{base}/uploads/{handle}', content=data, headers={'X-Asset-Name': name})
    assert upload.is_success, upload.text
    imported = command(client, base, 'asset.import', dict(uploadHandle=handle, name=name, expectedKind=kind))
    asset = client.get(f"{base}/assets/{imported['changed'][0]['id']}").json()
    reference = dict(assetId=asset['id'], revision=asset['revision'], fingerprint=asset['fingerprint'], kind=kind)
    node_ids = [str(uuid4()), str(uuid4())]
    for node, title in zip(node_ids, ('Source One', 'Source Two'), strict=True):
        command(client, base, 'canvas.show', {'item': dict(id=node, projectId=base.split('/')[-1],
            kind=kind, title=title, binding=dict(role='material', objectRef=reference))})
    return node_ids, reference


def send_turn(client, base, text, nodes, source):
    turn = str(uuid4())
    content = [dict(type='reference', nodeId=node, assetId=source['assetId'], fingerprint=source['fingerprint'])
               for node in nodes]
    return turn, client.post(base + '/assistant/turns', json=dict(id=turn, runtime='deepseek', text=text,
        content=[*content, {'type': 'text', 'text': text}], assets=[source['assetId']]))


def finished(response, reply='Done.'):
    assert response.is_success, response.text
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    last = events[-1]
    assert last['type'] == 'end' and last['error'] is None, events
    assert last['conversation']['messages'][-1]['text'] == reply
    return last['conversation']['messages']


@pytest.mark.merge
def test_image_generation_preserves_two_nodes_using_the_same_asset(project):
    client, base, provider = project
    nodes, source = source_nodes(client, base, 'portrait.png', 'image', png('red'))
    turn, response = send_turn(client, base, 'Generate an image using both selected nodes.', nodes, source)
    original, reply = finished(response)
    assert [ref['sourceVersion']['id'] for ref in original['turnReferences']] == nodes
    assert [ref['asset'] for ref in original['turnReferences']] == [source, source]
    plan = next(tool for tool in reply['tools'] if tool['name'] == 'opendirector canvas create-generation'
                and tool['status'] == 'complete' and tool['arguments'].get('type') == 'canvas.createGeneration')
    assert [ref['sourceVersion']['id'] for ref in plan['arguments']['payload']['references']] == nodes
    snapshot = client.get(base).json()
    assert [ref['sourceVersion']['id'] for ref in snapshot['references']] == nodes
    assert [ref['source'] for ref in snapshot['references']] == [source, source]
    job, = snapshot['jobs']
    assert job['status'] == 'succeeded' and job['agentRunId'] == turn
    assert [ref['sourceVersion']['id'] for ref in job['inputSnapshot']['references']] == nodes
    assert [ref['asset'] for ref in job['inputSnapshot']['references']] == [source, source]
    assert next(asset for asset in snapshot['assets'] if asset['id'] == source['assetId'])['revision'] == source['revision'] + 1
    published = next(asset for asset in snapshot['assets'] if asset['id'] == job['asset']['assetId'])
    assert published['provenance']['jobId'] == job['id']
    assert published['provenance']['sources'] == [source]
    assert provider.calls == [[source['assetId']]]


@pytest.mark.merge
@pytest.mark.requires_ffmpeg
def test_video_trim_publishes_the_selected_source_node_and_exact_asset(project, tmp_path):
    client, base, _ = project
    clip = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=20:d=1',
        '-f', 'lavfi', '-i', 'color=blue:s=64x48:r=20:d=1', '-filter_complex', 'concat=n=2:v=1:a=0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(clip)], check=True, timeout=15)
    nodes, source = source_nodes(client, base, clip.name, 'video', clip.read_bytes())
    _, response = send_turn(client, base, 'Plan a video trim from 1.2 to 1.7 seconds. Wait for confirmation.', nodes[1:], source)
    original, draft = finished(response, 'Ready to trim the selected source.')
    assert original['turnReferences'][0]['sourceVersion']['id'] == nodes[1]
    assert not any(tool['name'] == 'opendirector video trim' for tool in draft['tools'])
    assert len(client.get(base).json()['assets']) == 1
    response = client.post(base + '/assistant/turns', json=dict(id=str(uuid4()), runtime='deepseek',
        text='Trim the selected video using the confirmed plan.'))
    *_, confirmation, reply = finished(response)
    assert confirmation['turnReferences'] == []
    plan = next(tool for tool in reply['tools'] if tool['name'] == 'opendirector video trim'
                and tool['status'] == 'complete' and tool['arguments'].get('type') == 'video.trim')
    assert plan['arguments']['payload']['sourceItemId'] == nodes[1]
    assert plan['arguments']['payload']['source'] == source
    snapshot = client.get(base).json()
    published = next(asset for asset in snapshot['assets'] if asset['id'] != source['assetId'])
    assert published['provenance']['sourceItemId'] == nodes[1]
    assert published['provenance']['sources'] == [source]
    doc, = snapshot['editorDocuments']
    assert published['provenance']['editorDocumentId'] == doc['id']
    assert doc['data']['sourceItems'] == nodes[1:]
    assert doc['data']['sources'] == [source]
    assert doc['data']['parameters'] == {'startSeconds': 1.2, 'endSeconds': 1.7}
    output_node, = [item for item in snapshot['canvasItems'] if item['id'] not in nodes]
    assert output_node['visible'] and output_node['binding']['objectRef']['assetId'] == published['id']
    assert published['metadata']['durationSeconds'] == pytest.approx(.5, abs=.05)
    media = client.get(f"{base}/assets/{published['id']}/content")
    assert media.is_success, media.text
    output = tmp_path / 'output.mp4'
    output.write_bytes(media.content)
    frame = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-frames:v', '1',
        '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], check=True, capture_output=True, timeout=15).stdout
    with Image.open(BytesIO(frame)) as image:
        red, green, blue = image.convert('RGB').getpixel((32, 24))
    assert blue > 200 and red < 30 and green < 30


def test_rejects_stale_chat_source_before_creating_a_turn_or_job(project):
    client, base, provider = project
    nodes, source = source_nodes(client, base, 'portrait.png', 'image', png('red'))
    _, response = send_turn(client, base, 'Generate an image.', nodes,
                            {**source, 'fingerprint': 'sha256:' + 'a' * 64})
    assert response.status_code == 409 and response.json()['code'] == 'reference_invalid', response.text
    assert nodes[0] in response.json()['detail']
    assert client.get(base + '/assistant').json()['messages'] == []
    assert client.get(base).json()['jobs'] == []
    assert provider.calls == []
