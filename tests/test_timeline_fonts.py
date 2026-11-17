"""Real font bytes are validated before becoming retained timeline resources."""
from hashlib import sha256
from pathlib import Path

from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient
from opendirector_api.main import create_app

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont, newTable
import pytest

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_uploads import inspect_file


def tiny_font(path, *, characters='A', variable=False):
    """Small valid TrueType fixture with a controlled Unicode cmap."""
    glyphs = ['.notdef', *[f'g{ord(char)}' for char in characters]]
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(glyphs)
    builder.setupCharacterMap({ord(char): f'g{ord(char)}' for char in characters})
    outlines = {}
    for glyph in glyphs:
        pen = TTGlyphPen(None)
        pen.moveTo((0, 0)); pen.lineTo((500, 0)); pen.lineTo((250, 600)); pen.closePath()
        outlines[glyph] = pen.glyph()
    builder.setupGlyf(outlines)
    builder.setupHorizontalMetrics({glyph: (600, 0) for glyph in glyphs})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({'familyName': 'Controlled Fixture', 'styleName': 'Regular',
        'uniqueFontIdentifier': 'controlled', 'fullName': 'Controlled Fixture Regular', 'psName': 'Controlled-Regular'})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost(); builder.setupMaxp()
    if variable:
        table = newTable('fvar'); table.axes = []; table.instances = []
        builder.font['fvar'] = table
    builder.save(path)
    return path


def test_static_ttf_is_inspected_even_with_an_unhelpful_filename(tmp_path):
    path = tiny_font(tmp_path / 'content')
    kind, meta = inspect_file(path, 'upload.bin')
    assert kind == 'file'
    assert meta.mimeType == 'font/ttf'
    assert meta.size == path.stat().st_size


@pytest.mark.parametrize('payload', [b'plain text', b'\x00\x01\x00\x00broken', b'OTTO' + b'\x00' * 32])
def test_spoofed_or_corrupted_font_is_rejected(tmp_path, payload):
    path = tmp_path / 'content'; path.write_bytes(payload)
    with pytest.raises(ProjectError) as error:
        inspect_file(path, 'font.otf')
    assert error.value.code == ('timeline_font_unsupported' if payload == b'plain text' else 'timeline_font_invalid')


def test_font_size_is_bounded_before_parsing(tmp_path):
    path = tmp_path / 'content'
    with path.open('wb') as stream:
        stream.truncate(32 * 1024 * 1024 + 1)
    with pytest.raises(ProjectError) as error:
        inspect_file(path, 'huge.ttf')
    assert error.value.status == 413


def test_font_collection_and_variable_font_are_rejected(tmp_path):
    path = tiny_font(tmp_path / 'regular.ttf')
    collection = TTCollection(); collection.fonts = [TTFont(path)]
    collection.save(tmp_path / 'collection.ttc'); collection.close()
    variable = tiny_font(tmp_path / 'variable.ttf', variable=True)
    for path in [tmp_path / 'collection.ttc', variable]:
        with pytest.raises(ProjectError):
            inspect_file(path, path.name)


def test_cmap_coverage_uses_content_identity_and_rejects_missing_characters(tmp_path):
    from opendirector.media.fonts import require_font_characters
    first = tiny_font(tmp_path / 'first.ttf', characters='A')
    second = tiny_font(tmp_path / 'second.ttf', characters='B')
    fingerprint = lambda path: 'sha256:' + sha256(path.read_bytes()).hexdigest()
    require_font_characters(first, fingerprint(first), 'A\nA')
    require_font_characters(second, fingerprint(second), 'B')
    with pytest.raises(ProjectError):
        require_font_characters(second, fingerprint(second), 'A')
    with pytest.raises(ProjectError):
        require_font_characters(first, fingerprint(first), '中')


from test_creation_canvas_service import project, send, ver
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.creation.assets import AssetProvenance
from uuid import uuid4


def timeline_document(project, tmp_path, *, font_bytes=None):
    store, pid, session = project
    path = tiny_font(tmp_path / 'fixture.ttf', characters='AB中')
    record = CreationToolAssets(store).import_file(pid, uuid4(), 'fixture.ttf' if font_bytes is None else 'resource.bin',
        path.read_bytes() if font_bytes is None else font_bytes, session, provenance=AssetProvenance(source='upload'))
    font = CreationAssets(store).get(pid, record['id'])
    assert send(store, pid, 'asset.writeText', session=session, name='source.txt', text='AB中').status == 'applied'
    source = store.snapshot(pid).assets[-1]
    document = dict(id=uuid4(), projectId=pid, kind='timeline', data=dict(width=640, height=360, fps=24,
        tracks=[dict(id='visual', kind='visual', title='Visual')],
        fonts=[dict(id='font', title='Font', asset=asset_ref(font))],
        overlays=[dict(id='text', start=0, end=3, text='AB中', x=.1, y=.8, maxWidth=.8, fontId='font',
            style=dict(fontSize=18, color='#FFFFFF', align='center', lineHeight=1.2), sourceAsset=asset_ref(source))]))
    return document, font, source


@pytest.mark.parametrize('problem', ['not_font', 'missing_character', 'missing_font', 'missing_source'])
def test_editor_creation_rejects_unusable_font_or_text_source(project, tmp_path, problem):
    store, pid, session = project
    document, font, source = timeline_document(project, tmp_path, font_bytes=b'not a font' if problem == 'not_font' else None)
    if problem == 'missing_character':
        document['data']['overlays'][0]['text'] = '😀'
    if problem in {'missing_font', 'missing_source'}:
        asset = font if problem == 'missing_font' else source
        (store.root / 'Unified' / asset.path).unlink()
    before = store.snapshot(pid)
    receipt = send(store, pid, 'editor.create', session=session, document=document)
    assert receipt.status == 'rejected', receipt
    assert store.snapshot(pid) == before


def test_editor_save_revalidates_font_coverage_and_preserves_accepted_document(project, tmp_path):
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    before = store.snapshot(pid)
    doc = before.editorDocuments[0]
    changed = doc.model_dump(mode='json'); changed['data']['overlays'][0]['text'] = '缺'
    receipt = send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', doc)], document=changed)
    assert receipt.status == 'rejected', receipt
    assert store.snapshot(pid) == before


def test_timeline_source_refs_are_deterministic_and_include_retained_font_and_text(project, tmp_path):
    from opendirector.application.creation_timeline import timeline_source_refs
    from opendirector.domain.creation.editors import TimelineDocument
    document, font, source = timeline_document(project, tmp_path)
    doc = TimelineDocument.model_validate(document)
    assert timeline_source_refs(doc.data) == (asset_ref(font), asset_ref(source))


def test_retained_font_and_text_sources_have_usage_and_delete_protection(project, tmp_path):
    from opendirector.application.creation_history import CreationHistory
    from test_creation_history_service import deletion
    store, pid, session = project
    document, font, source = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    history = CreationHistory(store)
    for asset in [font, source]:
        usage = history.usage(store.snapshot(pid), asset.id)
        assert any(reason['type'] == 'editor_document' for reason in usage['reasons'])
        preview = history.delete_preview(pid, [asset.id], True)
        assert not preview['canDelete']
        assert store.execute(deletion(project, asset, preview), session=session).status == 'rejected'
        assert (store.root / 'Unified' / asset.path).exists()
    doc = store.snapshot(pid).editorDocuments[0]
    changed = doc.model_dump(mode='json'); changed['data'].update(fonts=[], overlays=[])
    assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', doc)], document=changed).status == 'applied'
    for asset in [font, source]:
        usage = history.usage(store.snapshot(pid), asset.id)
        assert any(reason['type'] == 'undo_history' for reason in usage['reasons'])
        assert not history.delete_preview(pid, [asset.id])['canDelete']


def test_actual_font_budget_is_checked_across_used_fonts(project, tmp_path):
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    # Valid static fonts with different cmap bytes and bounded trailing data.
    fonts, overlays = [], []
    for index, char in enumerate('ABC'):
        path = tiny_font(tmp_path / f'{index}.ttf', characters=char)
        with path.open('ab') as stream:
            stream.truncate(22 * 1024 * 1024)
        record = CreationToolAssets(store).import_file(pid, uuid4(), path.name, path.read_bytes(), session,
            provenance=AssetProvenance(source='upload'))
        asset = CreationAssets(store).get(pid, record['id'])
        fonts.append(dict(id=f'f{index}', title='Font', asset=asset_ref(asset)))
        overlays.append({**document['data']['overlays'][0], 'id': f't{index}', 'fontId': f'f{index}', 'text': char})
    document['data'].update(fonts=fonts, overlays=overlays)
    receipt = send(store, pid, 'editor.create', session=session, document=document)
    assert receipt.status == 'rejected', receipt
    assert not store.snapshot(pid).editorDocuments


def test_font_rejection_localizes_http_receipts_without_rewriting_stored_fact(project, tmp_path):
    from opendirector.domain.creation.commands import parse_command
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    document['data']['overlays'][0]['text'] = '缺'
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='editor.create', payload=dict(document=document)))
    api = TestClient(create_app(store.local), headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session})
    path = f'/api/creation/projects/{pid}/commands'
    zh = api.post(path, json=command.model_dump(mode='json'), headers={'Accept-Language': 'zh-CN'})
    en = api.post(path, json=command.model_dump(mode='json'), headers={'Accept-Language': 'en-US'})
    assert zh.status_code == en.status_code == 200
    assert zh.json()['issues'][0]['code'] == en.json()['issues'][0]['code'] == 'timeline_font_coverage'
    assert zh.json()['issues'][0]['message'] == '所选字体未覆盖全部文字字符。'
    assert en.json()['issues'][0]['message'] == 'The selected font does not cover all text characters.'
    assert store.receipt(pid, command.commandId).issues[0].message == '所选字体未覆盖全部文字字符。'
    replay = api.get(f'/api/creation/projects/{pid}/receipts/{command.commandId}', headers={'Accept-Language': 'zh-CN'})
    assert replay.json() == zh.json()


@pytest.mark.parametrize('language,expected', [('zh-CN', '请求字段无效，请检查必填项及字段格式。'),
    ('en-US', 'The request is invalid. Check the required fields and their formats.')])
def test_invalid_timeline_contract_http_error_does_not_echo_text_or_validator_english(project, tmp_path, language, expected):
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    document['data']['overlays'][0]['text'] = 'PRIVATE_CONTENT' * 400
    api = TestClient(create_app(store.local),
        headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session, 'Accept-Language': language})
    response = api.post(f'/api/creation/projects/{pid}/commands', json=dict(commandId=str(uuid4()), projectId=str(pid),
        type='editor.create', payload=dict(document=jsonable_encoder(document))))
    assert response.status_code == 422
    assert response.json() == dict(detail=expected, code='invalid_input')


def test_repeated_timeline_saves_reuse_verified_parsing_for_used_and_unused_fonts(project, tmp_path, monkeypatch):
    from collections import OrderedDict
    from opendirector.media import fonts
    # Observe real parser work, retaining both parsing and actual upload/service
    # effects. Removing cache reuse would parse these same bytes on every save.
    monkeypatch.setattr(fonts, '_cache', OrderedDict())
    parsed = []
    original_inspect = fonts._inspect
    def counted_inspection(value):
        parsed.append(sha256(value).hexdigest())
        return original_inspect(value)
    monkeypatch.setattr(fonts, '_inspect', counted_inspection)
    store, pid, session = project
    document, first, _ = timeline_document(project, tmp_path)
    second_path = tiny_font(tmp_path / 'unused.ttf', characters='B')
    record = CreationToolAssets(store).import_file(pid, uuid4(), second_path.name, second_path.read_bytes(), session,
        provenance=AssetProvenance(source='upload'))
    second = CreationAssets(store).get(pid, record['id'])
    document['data']['fonts'].append(dict(id='unused', title='Same family, different cmap', asset=asset_ref(second)))
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    assert parsed == [first.fingerprint.removeprefix('sha256:'), second.fingerprint.removeprefix('sha256:')]
    for text, font_id in [('AB', 'font'), ('B', 'unused'), ('A', 'font')]:
        doc = store.snapshot(pid).editorDocuments[0]
        changed = doc.model_dump(mode='json')
        changed['data']['overlays'][0].update(text=text, fontId=font_id)
        assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', doc)], document=changed).status == 'applied'
    assert len(parsed) == 2
    # A warm cache cannot turn a caller-supplied old fingerprint into evidence
    # for newly changed bytes, even when those bytes still form a valid font.
    with second_path.open('rb') as stream:
        with pytest.raises(ProjectError) as failure:
            fonts.require_font_characters(stream, first.fingerprint, 'B')
        assert failure.value.code == 'timeline_font_fingerprint'
    assert len(parsed) == 2


def test_preview_font_inspection_uses_actual_cmap_without_project_or_session(tmp_path):
    import base64
    from opendirector.infrastructure.local_projects import LocalProjects
    store = LocalProjects(tmp_path / 'data')
    client = TestClient(create_app(store))
    value = tiny_font(tmp_path / 'latin.ttf', characters='A ').read_bytes()
    headers = {'X-OpenDirector-Request': '1', 'Content-Type': 'application/octet-stream'}
    before = client.get('/api/creation/projects', headers=headers).json()
    response = client.post('/api/creation/fonts/inspect', content=value, headers=headers)
    assert response.status_code == 200
    result = response.json()
    assert set(result) == {'fingerprint', 'coverage'}
    assert result['fingerprint'] == 'sha256:' + sha256(value).hexdigest()
    mask = base64.b64decode(result['coverage'], validate=True)
    assert len(mask) == 0x110000 // 8
    assert mask[ord('A') >> 3] & (1 << (ord('A') & 7))
    assert not mask[ord('中') >> 3] & (1 << (ord('中') & 7))
    assert not mask[0x1F600 >> 3] & (1 << (0x1F600 & 7))
    assert client.get('/api/creation/projects', headers=headers).json() == before
    assert client.post('/api/creation/fonts/inspect', content=value).status_code == 403
    assert client.post('/api/creation/fonts/inspect', content=value,
        headers={**headers, 'Origin': 'https://untrusted.example'}).status_code == 403
    assert client.post('/api/creation/fonts/inspect', json={'path': '/etc/passwd'}, headers=headers).status_code == 400


def test_preview_font_inspection_bounds_stream_and_localizes_failures(tmp_path):
    from opendirector.infrastructure.local_projects import LocalProjects
    client = TestClient(create_app(LocalProjects(tmp_path / 'data')))
    headers = {'X-OpenDirector-Request': '1'}
    for language, message in [('en-US', 'Only static TTF'), ('zh-CN', '仅支持静态')]:
        response = client.post('/api/creation/fonts/inspect', content=b'not a font',
            headers={**headers, 'Accept-Language': language})
        assert response.status_code == 400
        assert message in response.json()['detail']
    response = client.post('/api/creation/fonts/inspect', content=iter([b'A' * (1024 * 1024)] * 33), headers=headers)
    assert response.status_code == 413
    response = client.post('/api/creation/fonts/inspect', content=b'',
        headers={**headers, 'Content-Length': str(33 * 1024 * 1024)})
    assert response.status_code == 413
