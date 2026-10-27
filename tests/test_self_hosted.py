import asyncio
import io
import json
from uuid import uuid4

import httpx
from PIL import Image
import pytest
from fastapi.testclient import TestClient

from museshow.infrastructure.local_projects import LocalProjects
from museshow.infrastructure.model_configs import ModelConfigs
from museshow.infrastructure.canvas import CanvasProjects
from museshow.integrations.providers import GenerationProviders
from museshow.integrations.reference_inputs import generation_references
from museshow.integrations.chat_completions import ChatCompletions
from museshow.domain.projects import ProjectError
from museshow_api.main import create_app


def test_self_hosted_models_support_optional_auth_all_four_kinds(tmp_path):
    store=LocalProjects(tmp_path)
    headers={'X-MuseShow-Request':'1','X-MuseShow-Session':str(uuid4())}
    with TestClient(create_app(store), headers=headers) as client:
        for kind in ('agent','image','video','audio'):
            value={'kind':kind,'url':'http://127.0.0.1:18091/v1','modelId':'local-model',
                   'connectionType':'self_hosted','authMode':'none'}
            response=client.post('/api/model-configs',json=value)
            assert response.status_code==200, response.text
            assert response.json()['authMode']=='none'
            assert response.json()['protocol']==('vllm_omni' if kind=='video' else 'openai')
            assert 'apiKey' not in response.json()
        key=client.post('/api/model-configs',json={**value,'authMode':'bearer','apiKey':'secret-token'}).json()
        assert key['authMode']=='bearer'
        client.patch('/api/model-configs/'+key['id'],json={**value,'authMode':'none'})
        assert ModelConfigs(store.repository).resolve(key['id'],'audio')['apiKey']==''


def test_legacy_settings_keep_provider_and_key_after_migration(tmp_path):
    configs=ModelConfigs(tmp_path)
    old={'id':str(uuid4()),'kind':'video','url':'https://ark.cn-beijing.volces.com/api/plan/v3',
         'modelId':'doubao-seedance-2.0','apiKey':'old-key'}
    configs.path.write_text(json.dumps({'version':1,'models':[old]}),encoding='utf-8')
    public=configs.list()[0]
    assert public['protocol']=='volcengine' and public['inputRules']['profile']=='seedance-2.0'
    configs.save('video',old['url'],old['modelId'],'',old['id'])
    assert configs.resolve(old['id'],'video')['apiKey']=='old-key'


def test_fasth3_multipart_carries_video_and_image_and_resumes_without_reupload(tmp_path):
    store=LocalProjects(tmp_path)
    session=str(uuid4()); owner=store.create('参考验证',str(uuid4()),session)['id']
    configs=ModelConfigs(store.repository)
    public=configs.save('video','http://localhost:18091/v1','FastH3-Omni','',connection_type='self_hosted')
    config=configs.resolve(public['id'],'video')
    image=io.BytesIO(); Image.new('RGB',(32,32),'red').save(image,'PNG')
    video={'id':str(uuid4()),'name':'原视频.mp4','kind':'video','type':'video/mp4','fingerprint':'fixture','durationMs':3000}
    photo={'id':str(uuid4()),'name':'角色.png','kind':'image','type':'image/png','fingerprint':'fixture'}
    assets={video['id']:(b'actual-video-payload',video),photo['id']:(image.getvalue(),photo)}
    store.asset=lambda project, asset: assets[asset]
    task={'kind':'video','projectId':owner,'prompt':'将 <Video 1> 人物替换为 <Picture 1>',
          'referenceIds':[video['id'],photo['id']],'videoMode':'reference',
          'parameters':{'seconds':'5','size':'832x480'}}
    prepared=generation_references(store,task,config)
    assert prepared['manifest'][0]['role']=='reference_video'
    requests=[]
    def handle(request):
        requests.append(request)
        assert 'authorization' not in request.headers
        if request.method=='POST':
            assert request.url.path=='/v1/videos'
            assert request.content.count(b'name="input_references"')==2
            assert b'actual-video-payload' in request.content and image.getvalue() in request.content
            assert b'ref2va' in request.content
            return httpx.Response(200,json={'id':'video-known'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200,content=b'generated-video')
        return httpx.Response(200,json={'id':'video-known','status':'completed'})
    provider=GenerationProviders(store,httpx.MockTransport(handle),poll_interval=0)
    async def run():
        accepted=[]
        async def submitted(value): accepted.append(value)
        assert await provider.generate(config,task,submitted)==('mp4',b'generated-video')
        assert accepted==['video-known']
        before=len(requests)
        store.asset=lambda *args: (_ for _ in ()).throw(AssertionError('must not reread references'))
        assert await provider.generate(config,{**task,'externalTaskId':'video-known'},submitted)==('mp4',b'generated-video')
        assert all(request.method=='GET' for request in requests[before:])
    asyncio.run(run())


def test_video_reference_connects_to_fasth3_but_not_seedance(tmp_path,monkeypatch):
    store=LocalProjects(tmp_path); session=str(uuid4())
    project=store.create('视频连线',str(uuid4()),session); canvas=CanvasProjects(store)
    monkeypatch.setattr('museshow.integrations.asset_metadata.probe',lambda *args: {'kind':'video','durationMs':3000,'width':320,'height':240,'frameRate':24,'hasAudio':False})
    asset=canvas.import_file(project['id'],str(uuid4()),'输入.mp4',b'video',session,str(uuid4()))
    configs=ModelConfigs(store.repository)
    hosted=configs.save('video','http://localhost:18091/v1','FastH3-Omni','',connection_type='self_hosted')
    source=next(n for n in canvas.snapshot(project['id'])['canvas']['nodes'] if n['assetId']==asset['id'])
    target=canvas.connect(project['id'],{'sourceId':source['id'],'assetId':asset['id'],'targetId':str(uuid4()),'kind':'video','x':500,'y':50},session)
    assert target['modelConfigId']==hosted['id'] and target['videoMode']=='reference'
    assert asset['id'] in target['referenceIds'] and canvas.snapshot(project['id'])['edges']
    managed=configs.save('video','https://ark.cn-beijing.volces.com/api/plan/v3','doubao-seedance-2.0','key')
    with pytest.raises(ProjectError):
        generation_references(store,{'kind':'video','projectId':project['id'],'prompt':'参考','referenceIds':[asset['id']],'videoMode':'reference'},configs.resolve(managed['id'],'video'))


def test_self_hosted_image_and_audio_use_compatible_routes_without_auth(tmp_path):
    store=LocalProjects(tmp_path)
    def handle(request):
        assert 'authorization' not in request.headers
        payload=json.loads(request.content)
        assert payload['model']=='model'
        if request.url.path.endswith('/audio/speech'):
            assert payload['input']=='你好' and payload['voice']=='alloy'
            return httpx.Response(200,content=b'audio')
        assert request.url.path.endswith('/images/generations')
        assert 'watermark' not in payload and payload['size']=='1024x1024'
        return httpx.Response(200,json={'data':[{'b64_json':'aW1hZ2U='}]})
    provider=GenerationProviders(store,httpx.MockTransport(handle))
    async def run():
        async def submitted(value): pass
        for kind,result in [('image',('png',b'image')),('audio',('mp3',b'audio'))]:
            config={'kind':kind,'protocol':'openai','modelId':'model','url':'http://localhost:9999/v1','apiKey':'','authMode':'none'}
            task={'kind':kind,'projectId':'owner','prompt':'你好','referenceIds':[],'parameters':{}}
            assert await provider.generate(config,task,submitted)==result
    asyncio.run(run())


@pytest.mark.parametrize('dimensions,expected', [((32,64),'480x832'),((64,32),'832x480')])
def test_fasth3_480p_follows_reference_orientation(tmp_path, dimensions, expected):
    from museshow.application.generation import Generation
    store=LocalProjects(tmp_path)
    session=str(uuid4()); owner=store.create('方向验证',str(uuid4()),session)['id']
    configs=ModelConfigs(store.repository)
    config=configs.save('video','http://localhost:18091/v1','FastH3-Omni','',connection_type='self_hosted')
    canvas=CanvasProjects(store)
    data=io.BytesIO(); Image.new('RGB',dimensions,'red').save(data,'PNG')
    asset=canvas.import_file(owner,str(uuid4()),'角色.png',data.getvalue(),session,str(uuid4()))
    source=next(n for n in canvas.snapshot(owner)['canvas']['nodes'] if n['assetId']==asset['id'])
    target=canvas.connect(owner,{'sourceId':source['id'],'assetId':asset['id'],'targetId':str(uuid4()),
        'kind':'video','x':500,'y':40,'modelConfigId':config['id'],'videoMode':'reference'},session)
    target=canvas.patch(owner,target['id'],{'expectedRevision':target['revision'],'prompt':'让人物自然挥手'},session)
    class Provider:
        def validate(self, kind, config): pass
    task,_,_=Generation(store,configs,Provider())._prepare(owner,target['id'],{
        'id':str(uuid4()),'modelConfigId':config['id'],'expectedRevision':target['revision']},session)
    assert task['parameters']['size']==expected
    assert task['parameters']['num_inference_steps']==8


@pytest.mark.parametrize('origin,expected_auth', [('http://localhost:9999','Bearer private-token'),('https://cdn.example',None)])
def test_self_hosted_image_result_auth_stays_on_configured_origin(tmp_path, origin, expected_auth):
    store=LocalProjects(tmp_path)
    def handle(request):
        if request.method=='POST':
            assert request.headers.get('authorization')=='Bearer private-token'
            return httpx.Response(200,json={'data':[{'url':origin+'/result.png'}]})
        assert request.headers.get('authorization')==expected_auth
        return httpx.Response(200,content=b'image')
    provider=GenerationProviders(store,httpx.MockTransport(handle))
    config={'kind':'image','protocol':'openai','modelId':'model','url':'http://localhost:9999/v1',
            'apiKey':'private-token','authMode':'bearer'}
    task={'kind':'image','projectId':'owner','prompt':'图片','referenceIds':[],'parameters':{}}
    async def submitted(value): pass
    assert asyncio.run(provider.generate(config,task,submitted))==('png',b'image')


def test_loopback_models_bypass_system_proxy_for_all_four_kinds(tmp_path, monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from museshow.integrations.http_settings import trust_environment
    calls=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, body, content_type='application/json'):
            if not isinstance(body,bytes): body=json.dumps(body).encode()
            self.send_response(200);self.send_header('Content-Type',content_type)
            self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_POST(self):
            calls.append(self.path)
            self.rfile.read(int(self.headers.get('Content-Length','0')))
            assert self.headers.get('Authorization') is None
            if self.path.endswith('/chat/completions'):
                self.reply(b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n','text/event-stream')
            elif self.path.endswith('/images/generations'):self.reply({'data':[{'b64_json':'aW1hZ2U='}]})
            elif self.path.endswith('/audio/speech'):self.reply(b'audio','audio/mpeg')
            else:self.reply({'id':'video-local'})
        def do_GET(self):
            calls.append(self.path)
            if self.path.endswith('/content'):self.reply(b'video','video/mp4')
            else:self.reply({'id':'video-local','status':'completed'})
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'):
        monkeypatch.setenv(key,'http://127.0.0.1:9')
    monkeypatch.setenv('NO_PROXY','');monkeypatch.setenv('no_proxy','')
    base=f'http://127.0.0.1:{server.server_port}/v1'
    config={'kind':'agent','protocol':'openai','modelId':'model','url':base,'apiKey':'','authMode':'none'}
    async def run():
        received=[part async for part in ChatCompletions().stream(config,{'model':'model','messages':[],'stream':True})]
        assert any(part.get('text')=='ok' for part in received)
        provider=GenerationProviders(LocalProjects(tmp_path),poll_interval=0)
        async def submitted(value): assert value=='video-local'
        for kind,result in [('image',('png',b'image')),('audio',('mp3',b'audio')),('video',('mp4',b'video'))]:
            task={'kind':kind,'projectId':'owner','prompt':'test','referenceIds':[],'videoMode':'reference','parameters':{}}
            assert await provider.generate({**config,'kind':kind,'protocol':'vllm_omni' if kind=='video' else 'openai'},task,submitted)==result
    try:
        asyncio.run(run())
        assert trust_environment('https://api.example/v1') is True
        assert trust_environment('http://localhost:8000/v1') is False
        assert trust_environment('http://[::1]:8000/v1') is False
        assert len(calls)==6
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)


def test_self_hosted_speech_uses_the_server_default_or_chosen_voice(tmp_path):
    store=LocalProjects(tmp_path); voices=[]
    def handle(request):
        voices.append(json.loads(request.content)['voice'])
        return httpx.Response(200,content=b'audio')
    provider=GenerationProviders(store,httpx.MockTransport(handle))
    config={'kind':'audio','protocol':'openai','connectionType':'self_hosted','modelId':'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
            'url':'http://localhost:9999/v1','apiKey':'','authMode':'none'}
    async def run():
        async def submitted(value): pass
        for parameters in ({},{'voice':'vivian'}):
            task={'kind':'audio','projectId':'owner','prompt':'你好','referenceIds':[],'parameters':parameters}
            assert await provider.generate(config,task,submitted)==('mp3',b'audio')
    asyncio.run(run())
    assert voices==['default','vivian']
