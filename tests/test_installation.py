"""Installed resources and writable project storage have distinct roots."""
from opendirector import installation


def test_wheel_defaults_to_user_workspace_not_package(monkeypatch, tmp_path):
    monkeypatch.delenv('OPENDIRECTOR_ROOT', raising=False)
    monkeypatch.setattr(installation, 'SOURCE_ROOT', None)
    monkeypatch.setattr(installation.Path, 'home', lambda: tmp_path)
    assert installation.data_root() == tmp_path / '.opendirector'
    assert installation.web_root() == installation.BUNDLED / 'web'
    assert installation.builtin_skills() == installation.BUNDLED / 'skills'


def test_explicit_workspace_does_not_replace_application_resources(monkeypatch, tmp_path):
    source = tmp_path / 'source'
    monkeypatch.setattr(installation, 'SOURCE_ROOT', source)
    monkeypatch.setenv('OPENDIRECTOR_ROOT', str(tmp_path / 'data'))
    assert installation.data_root() == tmp_path / 'data'
    assert installation.web_root() == source / 'dist'
    assert installation.builtin_skills() == source / 'packages/agent/skills'


def test_default_timeline_font_is_readonly_installation_resource(monkeypatch, tmp_path):
    from hashlib import sha256
    import json
    from opendirector.media.fonts import inspect_font, require_font_characters
    monkeypatch.setenv('OPENDIRECTOR_ROOT', str(tmp_path / 'workspace'))
    path = installation.default_timeline_font()
    resources = (installation.SOURCE_ROOT / 'public' if installation.SOURCE_ROOT is not None
                 else installation.BUNDLED / 'web')
    assert path.parent == resources / 'fonts'
    manifest = json.loads((path.parent / 'manifest.json').read_text(encoding='utf-8'))
    fingerprint = 'sha256:' + sha256(path.read_bytes()).hexdigest()
    assert manifest['fingerprint'] == fingerprint
    assert manifest['version'] == '2.004'
    assert inspect_font(path).mimeType == 'font/otf'
    require_font_characters(path, fingerprint, '中文 English 123，。\n字幕')
    assert not (tmp_path / 'workspace').exists()


def test_default_timeline_font_uses_wheel_web_resources(monkeypatch, tmp_path):
    from pathlib import Path
    import shutil
    source = Path(__file__).resolve().parents[1] / 'public/fonts'
    shutil.copytree(source, tmp_path / 'web/fonts')
    monkeypatch.setattr(installation, 'SOURCE_ROOT', None)
    monkeypatch.setattr(installation, 'BUNDLED', tmp_path)
    path = installation.default_timeline_font()
    assert path == tmp_path / 'web/fonts/NotoSansCJKsc-Regular.otf'
    assert path.is_file()
    assert (path.parent / 'LICENSE.txt').is_file()


def test_production_server_serves_packaged_fonts_without_exposing_other_files(monkeypatch, tmp_path):
    """Missing /fonts mount broke default text only after an installed build."""
    from pathlib import Path
    import shutil
    import os
    from process_helpers import directory_link
    from hashlib import sha256
    from fastapi.testclient import TestClient
    from opendirector.infrastructure.local_projects import LocalProjects
    from opendirector_api.main import create_app
    bundled = tmp_path / '_bundled'
    web = bundled / 'web'
    shutil.copytree(Path(__file__).resolve().parents[1] / 'public/fonts', web / 'fonts')
    (web / 'assets').mkdir()
    (web / 'assets/app.js').write_text('export {};', encoding='utf-8')
    (web / 'index.html').write_text('<html>App</html>', encoding='utf-8')
    (web / 'private.txt').write_text('not public', encoding='utf-8')
    if os.name == 'nt':
        directory_link(web / 'fonts/escape', web)
        escape_path = '/fonts/escape/private.txt'
    else:
        (web / 'fonts/escape.txt').symlink_to(web / 'private.txt')
        escape_path = '/fonts/escape.txt'
    monkeypatch.setattr(installation, 'SOURCE_ROOT', None)
    monkeypatch.setattr(installation, 'BUNDLED', bundled)
    client = TestClient(create_app(LocalProjects(tmp_path / 'data')))
    manifest = client.get('/fonts/manifest.json')
    assert manifest.status_code == 200
    font = client.get('/fonts/NotoSansCJKsc-Regular.otf')
    assert font.status_code == 200
    assert 'sha256:' + sha256(font.content).hexdigest() == manifest.json()['fingerprint']
    assert 'SIL OPEN FONT LICENSE' in client.get('/fonts/LICENSE.txt').text
    for path in ('/fonts/%2e%2e/private.txt', escape_path, '/private.txt', '/fonts/missing.otf'):
        assert client.get(path).status_code == 404
    assert client.post('/fonts/manifest.json').status_code == 405
    assert client.get('/assets/app.js').status_code == 200
    assert client.get('/ai-canvas/test').text == '<html>App</html>'
    assert client.get('/api/creation/projects', headers={'X-OpenDirector-Request': '1'}).status_code == 200
