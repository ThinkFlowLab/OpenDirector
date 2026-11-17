"""Timed text contracts preserve frame timing and actual saved project history."""
import json
from pathlib import Path
import shutil
from uuid import UUID

import pytest
from pydantic import ValidationError
from opendirector.domain.creation import editors
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects

FIXTURES = Path(__file__).parent / 'fixtures/timeline-text'
FONT = dict(assetId=str(UUID(int=87101)), revision=1, kind='file', fingerprint='sha256:'+'a'*64)


def data():
    return dict(fps=24,width=640,height=360,tracks=[dict(id='visual',kind='visual',title='',clips=[])],
        fonts=[dict(id='font',title='Fixture font',asset=FONT)],overlays=[dict(id='a',start=1,end=3,text='第一行\r\n第二行',x=.1,y=.82,maxWidth=.8,fontId='font',
        style=dict(fontSize=18,color='#FFFFFF',align='center',lineHeight=1.2,background=dict(color='#000000',opacity=.5,padding=4),stroke=dict(color='#000000',width=1)))])


def test_text_normalizes_line_endings_and_uses_half_open_frames_and_seconds():
    value=editors.TimelineData.model_validate(data())
    assert value.overlays[0].text == '第一行\n第二行'
    assert editors.timeline_text_frame_range(1,3,24) == (24,72)
    assert editors.timeline_text_frame_range(1/24,2/24,24) == (1,2)
    assert editors.timeline_duration(value) == 3
    changed=editors.TimelineData.model_validate({**data(),'fps':30})
    assert changed.overlays[0].start == 1 and changed.overlays[0].end == 3
    assert editors.timeline_duration(editors.TimelineData.model_validate({**data(),'overlays':[{**data()['overlays'][0],'start':2,'end':4}]})) == 4


@pytest.mark.parametrize('change', ['duplicate','unknown_font','time','empty_frame','nan','color','bounds','blank','control','length','total','font_kind'])
def test_invalid_text_is_rejected_at_the_shared_contract(change):
    value=data(); overlay=value['overlays'][0]
    if change=='duplicate': value['overlays'] *= 2
    elif change=='unknown_font': overlay['fontId']='missing'
    elif change=='time': overlay['end']=1
    elif change=='empty_frame': overlay.update(start=.001,end=.002)
    elif change=='nan': overlay['x']=float('nan')
    elif change=='color': overlay['style']['color']='red'
    elif change=='bounds': overlay['maxWidth']=1
    elif change=='blank': overlay['text']=' \n '
    elif change=='control': overlay['text']='a\0b'
    elif change=='length': overlay['text']='字'*4097
    elif change=='total': value['overlays']=[{**overlay,'id':str(i),'text':'字'*4096} for i in range(49)]
    elif change=='font_kind': value['fonts'][0]['asset']={**FONT,'kind':'image'}
    with pytest.raises(ValidationError): editors.TimelineData.model_validate(value)


def test_unicode_limits_count_codepoints_and_empty_new_fields_are_omitted():
    value=data();value['overlays'][0]['text']='😀'*4096
    assert len(editors.TimelineData.model_validate(value).overlays[0].text)==4096
    old={k:v for k,v in value.items() if k not in ('fonts','overlays')}
    saved=editors.TimelineData.model_validate(old).model_dump(mode='json')
    assert 'fonts' not in saved and 'overlays' not in saved
    schema=editors.TimelineData.model_json_schema(mode='serialization')
    assert 'fonts' not in schema['required'] and 'overlays' not in schema['required']


def test_pre_text_commits_reopen_and_replay_without_rewriting_fingerprints(tmp_path):
    store=CreationProjects(LocalProjects(tmp_path)); target=store.root/'Timeline baseline'
    shutil.copytree(FIXTURES/'legacy-project',target)
    pid=UUID(int=87001)
    before={p.name:p.read_bytes() for p in (target/'commits').glob('*.json')}
    assert store.snapshot(pid).editorDocuments[0].data.fps==30
    for path in sorted((target/'commits').glob('*.json')):
        bundle=json.loads(path.read_text()); command=parse_command(bundle['command'])
        assert store.execute(command).model_dump(mode='json')==bundle['receipt']
    assert before=={p.name:p.read_bytes() for p in (target/'commits').glob('*.json')}

@pytest.mark.parametrize('actor', ['ui', 'agent'])
def test_saved_text_fonts_order_and_source_survive_restart_and_shared_editor_save(tmp_path, actor):
    from opendirector.application.creation_tool_assets import CreationToolAssets
    from opendirector.application.creation_canvas import asset_ref
    from opendirector.domain.creation.assets import AssetProvenance
    from uuid import uuid4
    store=CreationProjects(LocalProjects(tmp_path));pid=uuid4();session=str(uuid4())
    def send(kind,payload,versions=()):
        return store.execute(parse_command(dict(commandId=uuid4(),projectId=pid,type=kind,payload=payload,expectedVersions=versions)),session=session if kind!='project.create' else None,source=actor)
    assert send('project.create',dict(name='Saved text')).status=='applied';store.open(pid,session)
    font=CreationToolAssets(store).import_file(pid,uuid4(),'Fixture.otf',(Path(__file__).parents[1]/'public/fonts/NotoSansCJKsc-Regular.otf').read_bytes(),session,provenance=AssetProvenance(source='upload'))
    assert send('asset.writeText',dict(name='source.txt',text='原始正文')).status=='applied'
    snapshot=store.snapshot(pid);font_asset=next(a for a in snapshot.assets if str(a.id)==font['id']);source=snapshot.assets[-1]
    value=data();value['fonts'][0]['asset']=asset_ref(font_asset);value['overlays'][0]['sourceAsset']=asset_ref(source)
    value['overlays'].append({**value['overlays'][0],'id':'b','start':2,'end':4,'text':'Mixed 中英'})
    eid=uuid4();document=dict(id=eid,projectId=pid,kind='timeline',data=value)
    assert send('editor.create',dict(document=document)).status=='applied'
    doc=store.snapshot(pid).editorDocuments[0];document=doc.model_dump(mode='json');document['data']['overlays'][0]['text']='用户与 Agent 接续'
    receipt=send('editor.save',dict(document=document),[dict(objectType='editor_document',id=eid,revision=doc.revision)])
    assert receipt.status=='applied',receipt
    reopened=CreationProjects(LocalProjects(tmp_path));saved=reopened.snapshot(pid).editorDocuments[0]
    assert saved.revision==2
    assert [o.id for o in saved.data.overlays]==['a','b']
    assert saved.data.overlays[0].text=='用户与 Agent 接续'
    assert saved.data.overlays[0].sourceAsset==asset_ref(source)
    assert saved.data.fonts[0].asset==asset_ref(font_asset)
    assert saved.data.overlays[0].style.background.padding==4
    assert editors.timeline_duration(saved.data)==4
    assert reopened.receipt(pid,receipt.commandId)==receipt

@pytest.mark.parametrize('change', ['track_collision','clip_collision','font_duplicate','font_limit','overlay_limit','style_limit','source_kind'])
def test_document_ids_counts_and_source_roles_are_bounded(change):
    value=data(); overlay=value['overlays'][0]
    if change=='track_collision': overlay['id']='visual'
    elif change=='clip_collision':
        image={**FONT,'kind':'image'}
        value['tracks'][0]['clips']=[dict(id='a',inPoint=0,outPoint=1,resource=dict(asset=image,title='Image'))]
    elif change=='font_duplicate':value['fonts']*=2
    elif change=='font_limit':value['fonts']=[{**value['fonts'][0],'id':f'font-{i}'} for i in range(17)]
    elif change=='overlay_limit':value['overlays']=[{**overlay,'id':f'text-{i}'} for i in range(2001)]
    elif change=='style_limit':overlay['style']['background']['padding']=129
    elif change=='source_kind':overlay['sourceAsset']=FONT
    with pytest.raises(ValidationError):editors.TimelineData.model_validate(value)
