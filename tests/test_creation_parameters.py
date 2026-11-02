"""UI-independent generation intent -> fixed job -> actual protocol requests/files."""
import asyncio
import base64
from email.parser import BytesParser
from email.policy import default
from io import BytesIO
import json
import subprocess
from uuid import UUID, uuid4

import httpx
from PIL import Image
import pytest

from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from test_creation_canvas_service import project, media, send, ver
from test_creation_generation_service import anyio_backend


def png(size=(32, 24), color='blue'):
    out = BytesIO()
    Image.new('RGB', size, color).save(out, 'PNG')
    return out.getvalue()


def form(request):
    message = BytesParser(policy=default).parsebytes(b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\n\r\n' + request.content)
    fields, files = {}, []
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if part.get_filename(): files.append((name, part.get_payload(decode=True)))
        else: fields[name] = part.get_payload(decode=True).decode()
    return fields, files


def setup(project, kind, parameters, handler, *, model='fixture', protocol='openai', caps=None, url='http://fixture.invalid/v1'):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('agent' if kind == 'text' else kind, url, model, 'fixture-key' if protocol == 'volcengine' else '',
                          connection_type='self_hosted', protocol=protocol, auth_mode='bearer' if protocol == 'volcengine' else 'none', video_capabilities=caps)
    runner = CreationGeneration(store, configs)
    runner.provider = GenerationProviders(runner.store, transport=httpx.MockTransport(handler), poll_interval=0)
    item, spec = media(project, kind)
    updated = spec.model_copy(update={'prompt': 'Make an output', 'modelConfigId': UUID(config['id']), 'parameters': type(spec.parameters).model_validate(parameters)})
    assert send(store, pid, 'generationSpec.update', session=session, versions=[ver('generation_spec', spec)], spec=updated).status == 'applied'
    return runner, item, spec.id


async def submit(project, runner, item, spec_id):
    store, pid, session = project
    snapshot = store.snapshot(pid)
    spec = next(s for s in snapshot.generationSpecs if s.id == spec_id)
    current = next(i for i in snapshot.canvasItems if i.id == item.id)
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', current)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
    return command, await runner.execute(command, session=session)


async def done(runner):
    await asyncio.wait_for(asyncio.gather(*(job.future for job in list(runner.jobs.values()))), 15)


@pytest.mark.anyio
@pytest.mark.parametrize('model,protocol,ratio,size,expected,reference_count', [
    ('fixture', 'openai', '3:2', '1536x1024', '1536x1024', 2),
    ('Qwen/Qwen-Image-2.1', 'openai', '9:16', 'auto', '768x1344', 2),
    ('Tongyi-MAI/Z-Image-Turbo', 'openai', '16:9', 'auto', '1344x768', 0),
    ('fixture', 'volcengine', None, '2K', '2K', 2),
])
async def test_image_parameters_reach_wire_and_real_output_with_fixed_sources(project, model, protocol, ratio, size, expected, reference_count):
    store, pid, session = project
    calls = []
    async def handler(request):
        if request.headers['content-type'].startswith('multipart/'):
            fields, files = form(request)
        else:
            fields, files = json.loads(request.content), []
        calls.append((fields, files))
        width, height = (2048, 2048) if expected == '2K' else map(int, expected.split('x'))
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png((width, height))).decode()}]})
    runner, target, spec_id = setup(project, 'image', dict(size=size, aspectRatio=ratio), handler, model=model, protocol=protocol)
    try:
        source_ids = []
        assets = CreationToolAssets(store)
        for color in ['red', 'green'][:reference_count]:
            record = assets.import_file(pid, uuid4(), color+'.png', png(color=color), session)
            asset = assets.assets.get(pid, record['id'])
            item_id = uuid4()
            assert send(store, pid, 'canvas.show', session=session, item=dict(id=item_id, projectId=pid, kind='image', binding=dict(role='material', objectRef=asset_ref(asset)))).status == 'applied'
            current = store.snapshot(pid)
            spec = next(s for s in current.generationSpecs if s.id == spec_id)
            target = next(item for item in current.canvasItems if item.id == target.id)
            added = send(store, pid, 'reference.add', session=session, versions=[ver('generation_spec', spec), ver('canvas_item', target)], reference=dict(id=uuid4(), projectId=pid, targetSpecId=spec_id, order=len(source_ids), binding='follow_current', source=dict(id=item_id)))
            assert added.status == 'applied', added
            source_ids.append(str(asset.id))
        command, receipt = await submit(project, runner, target, spec_id)
        assert receipt.status == 'accepted', receipt
        await done(runner)
        snapshot = store.snapshot(pid)
        job = snapshot.jobs[-1]
        assert job.status == 'succeeded', job.errorDetails
        assert job.adopted
        assert job.inputSnapshot.spec.parameters.aspectRatio == ratio
        assert job.inputSnapshot.spec.parameters.size == size
        assert job.execution.size == job.adapterParameters['size'] == calls[0][0]['size'] == expected
        assert [str(ref.asset.assetId) for ref in job.inputSnapshot.references] == source_ids
        fields, files = calls[0]
        if protocol == 'volcengine': assert len(fields.get('image', [])) == reference_count
        else: assert len(files) == reference_count
        if files: assert [data for _, data in files] == [png(color=color) for color in ['red', 'green']]
        asset = next(a for a in snapshot.assets if a.id == job.asset.assetId)
        assert (asset.metadata.width, asset.metadata.height) == ((2048, 2048) if expected == '2K' else tuple(map(int, expected.split('x'))))
        assert (await runner.execute(command, session=session)) == receipt
        assert len(calls) == 1
        assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid) == snapshot
    finally: await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('model,first_frame', [('fixture',False),('fixture',True),('MiniMaxAI/MiniMax-H3',False),('MiniMaxAI/MiniMax-H3',True),('FastH3-Omni',False)])
async def test_video_auto_resolution_respects_explicit_ratio_and_duration_on_wire(project, first_frame, model):
    store, pid, _ = project
    calls, uploads = [], []
    clip = subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=blue:s=48x84:r=10','-t','0.3','-threads','1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],capture_output=True,check=True).stdout
    def handler(request):
        if request.method == 'POST':
            fields, files = form(request)
            calls.append(fields); uploads.extend(files)
            return httpx.Response(200,json={'id':'video-1'})
        if request.url.path.endswith('/content'): return httpx.Response(200,content=clip)
        return httpx.Response(200,json={'status':'completed'})
    caps=dict(outputs=[dict(resolution='480P',width=832,height=480,durations=[5,8])],defaultResolution='480P',defaultDuration=5,dimensionStep=32)
    runner,target,spec_id=setup(project,'video',dict(videoMode='first_frame' if first_frame else 'reference',durationSeconds=8,aspectRatio='9:16',resolution='auto'),handler,model=model,protocol='vllm_omni',caps=caps)
    try:
        if first_frame:
            assets = CreationToolAssets(store)
            for index, color in enumerate(['red', 'green']):
                record = assets.import_file(pid, uuid4(), color+'.png', png(color=color), project[2])
                asset = assets.assets.get(pid, record['id']); source_id = uuid4()
                assert send(store, pid, 'canvas.show', session=project[2], item=dict(id=source_id,projectId=pid,kind='image',binding=dict(role='material',objectRef=asset_ref(asset)))).status == 'applied'
                snapshot = store.snapshot(pid); spec = snapshot.generationSpecs[-1]
                current = next(i for i in snapshot.canvasItems if i.id == target.id)
                assert send(store,pid,'reference.add',session=project[2],versions=[ver('generation_spec',spec),ver('canvas_item',current)],reference=dict(id=uuid4(),projectId=pid,targetSpecId=spec_id,order=index,binding='follow_current',source=dict(id=source_id),role='first_frame' if index==1 else 'reference')).status == 'applied'
        _,receipt=await submit(project,runner,target,spec_id)
        assert receipt.status=='accepted',receipt
        await done(runner)
        snapshot=store.snapshot(pid); job=snapshot.jobs[-1]
        assert job.status=='succeeded',job.errorDetails
        assert calls[0]['size']=='480x832'
        if model == 'MiniMaxAI/MiniMax-H3':
            assert calls[0]['num_frames'] == str(job.execution.numFrames) == '192'
            assert calls[0]['fps'] == str(job.execution.fps) == '24'
        else:
            assert calls[0]['seconds']=='8'
            if model == 'FastH3-Omni':
                assert job.execution.numFrames is None and 'num_frames' not in calls[0]
                assert json.loads(calls[0]['extra_params'])['duration'] == 8
                assert calls[0]['fps'] == str(job.execution.fps) == '24'
        assert job.execution.generateAudio is None
        assert job.execution.size=='480x832' and job.execution.durationSeconds==8
        assert job.inputSnapshot.spec.parameters.resolution=='auto'
        assert snapshot.generationSpecs[-1].parameters.videoMode==('first_frame' if first_frame else 'reference')
        assert [data for _,data in uploads]==([png(color='green')] if first_frame else [])
        if first_frame: assert [r.transmission for r in job.inputSnapshot.references]==['context_only','content']
        assert job.inputSnapshot.spec.parameters.videoMode==('reference' if model=='FastH3-Omni' else 'first_frame')
        assert job.adopted
    finally: await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('protocol', ['openai','volcengine'])
async def test_audio_voice_reaches_actual_protocol_and_reopens(project,protocol):
    store,pid,_=project
    calls=[]
    audio=subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=24000','-t','0.3','-threads','1','-f','mp3','pipe:1'],capture_output=True,check=True).stdout
    def handler(request):
        calls.append(json.loads(request.content))
        if protocol=='openai': return httpx.Response(200,content=audio)
        return httpx.Response(200,text=json.dumps({'code':0,'data':base64.b64encode(audio).decode()})+'\n'+json.dumps({'code':20000000})+'\n')
    runner,target,spec_id=setup(project,'audio',dict(voice='voice_test-1',mode='tts',creationType='audio'),handler,protocol=protocol,model='doubao-seed-tts-2.0' if protocol=='volcengine' else 'fixture')
    try:
        _,receipt=await submit(project,runner,target,spec_id)
        assert receipt.status=='accepted',receipt
        await done(runner)
        snapshot=store.snapshot(pid);job=snapshot.jobs[-1]
        assert job.status=='succeeded',job.errorDetails
        if protocol=='openai': assert calls[0]['voice']==job.execution.voice=='voice_test-1'
        else: assert calls[0]['req_params']['speaker']==job.execution.speaker=='voice_test-1'
        assert job.inputSnapshot.spec.parameters.voice=='voice_test-1'
        assert 'fixture-key' not in job.model_dump_json()
        assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)==snapshot
    finally: await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('lyrics,expected', [('[verse]\n雨落在窗前', '[verse]\n雨落在窗前'), ('', '[intro]\n[verse]\n[chorus]\n[outro]')])
async def test_music_style_lyrics_and_length_reach_vllm_omni_music(project,lyrics,expected):
    store,pid,_=project
    calls=[]
    audio=subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.3','-ac','2','-threads','1','-f','mp3','pipe:1'],capture_output=True,check=True).stdout
    def handler(request):
        assert request.url.path=='/v1/audio/speech'
        calls.append(json.loads(request.content))
        return httpx.Response(200,content=audio)
    runner,target,spec_id=setup(project,'audio',dict(creationType='music',lyrics=lyrics,durationSeconds=45),handler,protocol='vllm_omni_music',model='m-a-p/YuE2-3B')
    try:
        _,receipt=await submit(project,runner,target,spec_id)
        assert receipt.status=='accepted',receipt
        await done(runner)
        job=store.snapshot(pid).jobs[-1]
        assert job.status=='succeeded',job.errorDetails
        assert calls==[{'model':'m-a-p/YuE2-3B','input':expected,'instructions':'Make an output','response_format':'mp3','max_new_tokens':1125}]
        assert job.execution.creationType=='music' and job.execution.maxDurationSeconds==45
        assert job.inputSnapshot.model.inputRules.profile=='vllm-omni-music'
    finally: await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('kind,parameters,protocol', [
    ('audio',dict(creationType='audio'), 'vllm_omni_music'),
    ('image',dict(aspectRatio='16:9'), 'openai'),
    ('image',dict(size='4096x4096'), 'openai'),
    ('image',dict(preset='product-views'), 'openai'),
    ('audio',dict(creationType='music'), 'openai'),
    ('audio',dict(mode='unified'), 'openai'),
    ('video',dict(generateAudio=False), 'vllm_omni'),
    ('video',dict(aspectRatio='9:16',resolution='auto'), 'vllm_omni'),
])
async def test_unsupported_intent_rejected_before_acceptance(project,kind,parameters,protocol):
    calls=[]
    runner,target,spec_id=setup(project,kind,parameters,lambda request:calls.append(request),protocol=protocol)
    try:
        _,receipt=await submit(project,runner,target,spec_id)
        assert receipt.status=='rejected',receipt
        assert not project[0].snapshot(project[1]).jobs and not calls
    finally: await runner.close()


@pytest.mark.anyio
async def test_text_token_limit_and_thinking_reach_streaming_request(project):
    calls=[]
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, text='data: '+json.dumps({'choices':[{'delta':{'content':'Actual text'},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n', headers={'Content-Type':'text/event-stream'})
    runner,target,spec_id=setup(project,'text',dict(thinking='high',maxTokens=2048),handler)
    try:
        _,receipt=await submit(project,runner,target,spec_id)
        assert receipt.status=='accepted',receipt
        await done(runner)
        job=project[0].snapshot(project[1]).jobs[-1]
        assert job.status=='succeeded',job.errorDetails
        assert calls[0]['max_tokens']==job.execution.maxTokens==2048
        assert calls[0]['reasoning_effort']==job.execution.thinking=='high'
    finally: await runner.close()


@pytest.mark.anyio
async def test_parameter_edits_leave_accepted_input_fixed_and_restore_is_explicit(project):
    store,pid,session=project
    started,finish=asyncio.Event(),asyncio.Event()
    async def handler(request):
        started.set();await finish.wait()
        return httpx.Response(200,json={'data':[{'b64_json':base64.b64encode(png((1536,1024))).decode()}]})
    runner,target,spec_id=setup(project,'image',dict(aspectRatio='3:2',size='auto'),handler)
    try:
        command,receipt=await submit(project,runner,target,spec_id)
        assert receipt.status=='accepted'
        await asyncio.wait_for(started.wait(),3)
        spec=store.snapshot(pid).generationSpecs[-1]
        next_spec=spec.model_copy(update={'parameters':spec.parameters.model_copy(update={'aspectRatio':'1:1'})})
        assert send(store,pid,'generationSpec.update',session=session,versions=[ver('generation_spec',spec)],spec=next_spec).status=='applied'
        finish.set();await done(runner)
        snapshot=store.snapshot(pid);job=snapshot.jobs[-1];result=snapshot.results[-1]
        assert job.status=='succeeded' and not job.adopted
        assert job.inputSnapshot.spec.parameters.aspectRatio=='3:2' and job.execution.size=='1536x1024'
        current=snapshot.generationSpecs[-1]
        assert current.parameters.aspectRatio=='1:1' and current.currentResultId is None
        assert send(store,pid,'result.select',session=session,versions=[ver('generation_spec',current)],specId=spec_id,resultId=result.id).status=='applied'
        current=store.snapshot(pid).generationSpecs[-1]
        assert send(store,pid,'generationSpec.restore',session=session,versions=[ver('generation_spec',current)],specId=spec_id,commandId=command.commandId,referencePolicy='pinned').status=='applied'
        snapshot=store.snapshot(pid)
        assert snapshot.generationSpecs[-1].parameters.aspectRatio=='3:2'
        assert snapshot.generationSpecs[-1].currentResultId==result.id
        assert snapshot.jobs[-1].inputSnapshot==job.inputSnapshot
        assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)==snapshot
    finally: finish.set();await runner.close()


@pytest.mark.anyio
@pytest.mark.parametrize('generate_audio', [True, False])
async def test_seedance_audio_ratio_duration_and_resolution_reach_wire(project, generate_audio):
    calls=[]
    clip=subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=blue:s=48x84:r=10','-t','0.3','-threads','1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],capture_output=True,check=True).stdout
    def handler(request):
        if request.method=='POST':
            calls.append(json.loads(request.content))
            return httpx.Response(200,json={'id':'seedance-1'})
        if request.url.path.endswith('/result.mp4'): return httpx.Response(200,content=clip)
        return httpx.Response(200,json={'status':'succeeded','content':{'video_url':'http://fixture.invalid/result.mp4'}})
    runner,target,spec_id=setup(project,'video',dict(durationSeconds=8,aspectRatio='9:16',resolution='720P',generateAudio=generate_audio),handler,model='doubao-seedance-2.0',protocol='volcengine',url='https://ark.cn-beijing.volces.com/api/plan/v3')
    try:
        _,receipt=await submit(project,runner,target,spec_id)
        assert receipt.status=='accepted',receipt
        await done(runner)
        job=project[0].snapshot(project[1]).jobs[-1]
        assert job.status=='succeeded',job.errorDetails
        assert calls[0]['generate_audio']==job.execution.generateAudio==generate_audio
        assert calls[0]['ratio']==job.inputSnapshot.spec.parameters.aspectRatio=='9:16'
        assert calls[0]['duration']==job.execution.durationSeconds==8
        assert calls[0]['resolution']==job.execution.resolution=='720p'
        assert job.adopted
    finally: await runner.close()
