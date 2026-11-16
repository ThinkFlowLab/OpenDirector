"""Global library: backup semantics, dedupe and the trash lifecycle.

Every test names the invariant it defends (docs/ASSET-LIBRARY-DESIGN.md §5).
"""
from io import BytesIO
import json
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.creation_uploads import CreationUploads
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app


pytestmark = pytest.mark.cpu


def png(color='purple', size=(13, 7)):
    buffer = BytesIO()
    Image.new('RGB', size, color).save(buffer, format='PNG')
    return buffer.getvalue()


def command(project_id, kind='project.create', **payload):
    return parse_command(dict(projectId=project_id, commandId=uuid4(), type=kind, payload=payload))


@pytest.fixture
def store(tmp_path):
    return LocalProjects(tmp_path)


@pytest.fixture
def app(tmp_path, store):
    return tmp_path, create_app(store)


@pytest.fixture
def client(app):
    _, application = app
    return TestClient(application, headers={'X-OpenDirector-Request': '1'})


def upload(client, data=None, name='frame.png', mime='image/png'):
    return client.post(f'/api/library/items/upload?name={name}',
                       content=data if data is not None else png(),
                       headers={'content-type': mime})


def seed_canvas_asset(store, data=None):
    """Create a real project asset so canvas-origin imports have a source."""
    projects = CreationProjects(store)
    project_id, session = uuid4(), str(uuid4())
    projects.execute(command(project_id, name='Library source'))
    projects.open(project_id, session)
    handle = uuid4()
    writer = CreationUploads(projects).begin(project_id, handle, session, 'hero.png')
    try:
        writer.write(png() if data is None else data)
        info = writer.finish()
    finally:
        writer.abort()
    receipt = projects.execute(
        command(project_id, 'asset.import', uploadHandle=info.id,
                name=info.name, expectedKind=info.kind), session=session)
    asset_id = next((change.id for change in receipt.changed
                     if change.objectType == 'asset'), None)
    assert asset_id is not None, f'asset.import changed no asset: {receipt!r}'
    return project_id, asset_id


def test_upload_lists_and_serves_content(client):
    response = upload(client, name='cat.png')
    assert response.status_code == 200, response.text
    item = response.json()
    assert item['kind'] == 'asset' and item['state'] == 'active'
    assert item['mediaKind'] == 'image'
    assert item['origin']['type'] == 'upload'

    listing = client.get('/api/library/items').json()
    assert [row['id'] for row in listing] == [item['id']]

    content = client.get(f"/api/library/items/{item['id']}/content")
    assert content.status_code == 200
    assert content.headers['content-type'].startswith('image/png')
    assert Image.open(BytesIO(content.content)).size == (13, 7)


def test_media_kind_filters_and_search(client):
    upload(client, png('red'), 'red.png')
    upload(client, png('blue'), 'blue.png')
    upload(client, b'%PDF-1.4 hello', 'brief.pdf', mime='application/pdf')

    images = client.get('/api/library/items?mediaKind=image').json()
    files = client.get('/api/library/items?mediaKind=file').json()
    assert len(images) == 2 and len(files) == 1
    assert [row['name'] for row in client.get('/api/library/items?query=blue').json()] == ['blue.png']


def test_identical_bytes_are_stored_once(client, tmp_path):
    """L6: content addressing keeps one blob for equal payloads."""
    payload = png('green')
    first = upload(client, payload, 'a.png').json()
    second = upload(client, payload, 'b.png').json()
    assert first['blob'] == second['blob']

    blobs = list((tmp_path / '.opendirector' / 'library' / 'blobs').iterdir())
    assert len(blobs) == 1


def test_trash_hides_item_but_keeps_bytes(client, tmp_path):
    """L4/L5: deleting only flips state; bytes stay until purged."""
    item = upload(client).json()
    trashed = client.post('/api/library/items/trash', json={'itemIds': [item['id']]})
    assert trashed.status_code == 200
    assert trashed.json()[0]['state'] == 'trashed'
    assert trashed.json()[0]['trashedAt']

    assert client.get('/api/library/items').json() == []
    assert len(client.get('/api/library/items?state=trashed').json()) == 1
    assert len(list((tmp_path / '.opendirector' / 'library' / 'blobs').iterdir())) == 1

    restored = client.post('/api/library/trash/restore', json={'itemIds': [item['id']]})
    assert restored.json()[0]['state'] == 'active'
    assert len(client.get('/api/library/items').json()) == 1


def test_purge_keeps_blobs_still_referenced(client, tmp_path):
    """L5: identical payloads survive until the last item is purged."""
    payload = png('orange')
    first = upload(client, payload, 'keep.png').json()
    second = upload(client, payload, 'drop.png').json()
    assert first['blob'] == second['blob']

    client.post('/api/library/items/trash', json={'itemIds': [second['id']]})
    purged = client.delete(f"/api/library/trash/{second['id']}")
    assert purged.status_code == 200
    assert len(list((tmp_path / '.opendirector' / 'library' / 'blobs').iterdir())) == 1

    client.post('/api/library/items/trash', json={'itemIds': [first['id']]})
    client.delete(f"/api/library/trash/{first['id']}")
    assert list((tmp_path / '.opendirector' / 'library' / 'blobs').iterdir()) == []


def test_purge_rejects_active_items(client):
    item = upload(client).json()
    assert client.delete(f"/api/library/trash/{item['id']}").status_code == 422
    assert client.get('/api/library/items').json()[0]['id'] == item['id']


def test_inline_canvas_media_is_backed_up_as_a_copy(client, tmp_path):
    """L1: media embedded in a canvas document (no asset id) still backs up."""
    payload = png('teal', (17, 11))
    project_id = uuid4()
    created = client.post(
        f'/api/library/items/from-canvas-inline?name=inline.png&project_id={project_id}',
        content=payload,
        headers={'content-type': 'image/png'},
    )
    assert created.status_code == 200, created.text
    item = created.json()
    assert item['origin']['type'] == 'canvas'
    assert item['origin']['projectId'] == str(project_id)
    assert item['mediaKind'] == 'image'
    assert item['metadata']['size'] == len(payload)

    served = client.get(f"/api/library/items/{item['id']}/content")
    assert served.status_code == 200
    assert served.content == payload

    # The bytes live in the library, not inside the project directory.
    assert (tmp_path / '.opendirector' / 'library' / 'blobs' / item['blob']).exists()


def test_inline_backup_rejects_an_empty_body(client):
    rejected = client.post(
        '/api/library/items/from-canvas-inline?name=empty.png',
        content=b'',
        headers={'content-type': 'image/png'},
    )
    assert rejected.status_code == 422


def test_canvas_import_is_a_backup_not_a_reference(app, client, store):
    """L1/L4: deleting the canvas copy must not disturb the library."""
    tmp_path, _ = app
    project_id, asset_id = seed_canvas_asset(store)

    imported = client.post('/api/library/items/from-canvas',
                           json={'projectId': str(project_id), 'assetId': str(asset_id),
                                 'name': 'hero (library)'})
    assert imported.status_code == 200, imported.text
    item = imported.json()
    assert item['origin']['type'] == 'canvas'
    assert item['origin']['projectId'] == str(project_id)

    # Remove the canvas-side file entirely, then prove the library still serves it.
    canvas_file = tmp_path / 'projects' / 'Library source' / 'assets' / str(asset_id)
    assert canvas_file.exists()
    canvas_blob = item['blob']
    canvas_file.unlink()

    served = client.get(f"/api/library/items/{item['id']}/content")
    assert served.status_code == 200
    library_file = tmp_path / '.opendirector' / 'library' / 'blobs' / canvas_blob
    assert library_file.exists()


def test_subject_and_asset_payloads_stay_separate(client):
    """L2: subjects never masquerade as plain media."""
    item = upload(client).json()
    renamed = client.patch(f"/api/library/items/{item['id']}", json={'name': '新名字'})
    assert renamed.json()['name'] == '新名字'

    assert client.get(f"/api/library/items/{item['id']}/content").status_code == 200
    assert client.get('/api/library/items?kind=subject').json() == []


def test_trash_writes_nothing_inside_projects(client, tmp_path, store):
    """L4: the library never mutates canvas directories."""
    project_id, _ = seed_canvas_asset(store)
    project_dir = tmp_path / 'projects' / 'Library source'
    before = {p.name: p.stat().st_mtime_ns for p in project_dir.rglob('*') if p.is_file()}

    item = upload(client).json()
    client.post('/api/library/items/trash', json={'itemIds': [item['id']]})
    client.delete('/api/library/trash')

    after = {p.name: p.stat().st_mtime_ns for p in project_dir.rglob('*') if p.is_file()}
    assert before == after
