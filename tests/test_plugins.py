"""Optional packages preserve native loading, project content and filesystem boundaries."""
import asyncio
from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
import shutil
import stat
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from fastapi.testclient import TestClient
import httpx
import pytest

from opendirector.agent.context import RunContext
from opendirector.agent.plugins import PluginRegistry, package_files, download_package, MAX_FILE_BYTES
from opendirector.agent.skills import skills
from opendirector.agent.skill_snapshot import prepare_skills
from opendirector.domain.projects import ProjectError
from opendirector.domain.creation.commands import parse_command
from opendirector.application.creation_canvas import asset_ref
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.installation import plugin_examples
from opendirector_api.main import create_app
from test_agent_artifacts import publication
from test_assistant_conversations import assistant
from process_helpers import directory_link

pytestmark = pytest.mark.ready
HEADERS = {'X-OpenDirector-Request': '1', 'Accept-Language': 'en-US'}


def custom_package(tmp_path, plugin_id='custom-brief', **changes):
    root = tmp_path / plugin_id
    shutil.copytree(plugin_examples() / 'studio-brief', root)
    manifest = json.loads((root / 'opendirector-plugin.json').read_text())
    manifest.update(id=plugin_id, **changes)
    (root / 'opendirector-plugin.json').write_text(json.dumps(manifest), encoding='utf-8')
    (root / 'skills/studio-brief').rename(root / 'skills' / plugin_id)
    entry = root / 'skills' / plugin_id / 'SKILL.md'
    entry.write_text(entry.read_text().replace('name: studio-brief', f'name: {plugin_id}'), encoding='utf-8')
    return root


def zipped(root, extra=()):
    output = BytesIO()
    with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
        for path in sorted(root.rglob('*')):
            if path.is_file():
                archive.writestr(path.relative_to(root).as_posix(), path.read_bytes())
        for name, value in extra:
            archive.writestr(name, value)
    return output.getvalue()


def test_install_enable_restart_disable_and_uninstall(tmp_path):
    repository = tmp_path / 'workspace'
    source = custom_package(tmp_path)
    registry = PluginRegistry(repository)
    assert registry.catalog()['installed'] == []
    assert registry.catalog()['examples'][0]['manifest']['id'] == 'studio-brief'
    item = registry.install(str(source))
    assert item['enabledRuntimes'] == []
    assert registry.skills('default') == []
    registry.change('custom-brief', item['digest'], runtime='codex', enabled=True)
    replay = registry.install(zipped(source))
    assert replay['digest'] == item['digest']
    assert replay['enabledRuntimes'] == ['codex']
    restarted = PluginRegistry(repository)
    assert restarted.skills('default') == []
    loaded = restarted.skills('codex')
    assert loaded[0]['pluginId'] == 'custom-brief'
    work = tmp_path / 'work'
    prepare_skills(work, loaded)
    saved = (work / '.agents/skills/custom-brief/SKILL.md').read_bytes()
    restarted.change('custom-brief', item['digest'], runtime='codex', enabled=False)
    assert restarted.skills('codex') == []
    restarted.change('custom-brief', item['digest'])
    assert restarted.catalog()['installed'] == []
    assert (work / '.agents/skills/custom-brief/SKILL.md').read_bytes() == saved
    assert Path(loaded[0]['filePath']).read_bytes() == saved
    assert not (repository / 'projects').exists()


def test_dependencies_versions_and_conflicts_preserve_state(tmp_path):
    registry = PluginRegistry(tmp_path / 'workspace')
    base = registry.install('example:studio-brief')
    extra = registry.install(str(custom_package(tmp_path, dependencies={'studio-brief': '1.0.0'})))
    with pytest.raises(ProjectError) as error:
        registry.change('custom-brief', extra['digest'], runtime='codex', enabled=True)
    assert error.value.code == 'plugin_dependency_missing'
    registry.change('studio-brief', base['digest'], runtime='default', enabled=True)
    with pytest.raises(ProjectError):
        registry.change('custom-brief', extra['digest'], runtime='codex', enabled=True)
    registry.change('studio-brief', base['digest'], runtime='codex', enabled=True)
    registry.change('custom-brief', extra['digest'], runtime='codex', enabled=True)
    before = registry.path.read_bytes()
    for kwargs in ({}, {'runtime': 'codex', 'enabled': False}):
        with pytest.raises(ProjectError) as error:
            registry.change('studio-brief', base['digest'], **kwargs)
        assert error.value.code == 'plugin_required'
        assert registry.path.read_bytes() == before
    with pytest.raises(ProjectError) as error:
        registry.change('studio-brief', '0' * 64, runtime='codex', enabled=False)
    assert error.value.code == 'plugin_changed'
    source = custom_package(tmp_path, 'new-brief', runtimes=['codex'])
    newer = registry.install(str(source))
    with pytest.raises(ProjectError) as error:
        registry.change('new-brief', newer['digest'], runtime='default', enabled=True)
    assert error.value.code == 'plugin_runtime_unsupported'
    (source / 'skills/new-brief/SKILL.md').write_text((source / 'skills/new-brief/SKILL.md').read_text() + '\nchanged')
    with pytest.raises(ProjectError) as error:
        registry.install(str(source))
    assert error.value.code == 'plugin_conflict'


@pytest.mark.parametrize('name', ['../outside', '/outside', 'skills/../../outside', 'C:/outside',
                                  'skills\\outside', 'a//b', './outside', 'con.txt', 'name.',
                                  'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\nb', 'a\rb', 'a\tb', 'a\x01b'])
def test_archive_paths_cannot_escape_or_alias(tmp_path, name):
    registry = PluginRegistry(tmp_path / 'workspace')
    source = custom_package(tmp_path)
    with pytest.raises(ProjectError) as error:
        registry.install(zipped(source, [(name, b'bad')]))
    assert error.value.code == 'plugin_unsafe_path'
    assert registry.catalog()['installed'] == []
    assert not (tmp_path / 'outside').exists()


def test_links_special_files_duplicate_paths_and_bombs_are_rejected(tmp_path):
    source = custom_package(tmp_path)
    link = ZipInfo('link')
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    fifo = ZipInfo('pipe')
    fifo.create_system = 3
    fifo.external_attr = (stat.S_IFIFO | 0o600) << 16
    for extra in ([(link, b'/etc/passwd')], [(fifo, b'')], [('README', b'a'), ('readme', b'b')],
                  [('dir/a', b'a'), ('DIR/b', b'b')], [('file', b'a'), ('file/child', b'b')],
                  [('é.txt', b'a'), ('e\u0301.txt', b'b')],
                  [('large.txt', b'x' * (MAX_FILE_BYTES + 1))]):
        with pytest.raises(ProjectError):
            package_files(zipped(source, extra))
    unsupported = bytearray(zipped(source))
    for signature, offset in ((b'PK\x03\x04', 8), (b'PK\x01\x02', 10)):
        position = unsupported.index(signature) + offset
        unsupported[position:position + 2] = (99).to_bytes(2, 'little')
    with pytest.raises(ProjectError) as error:
        package_files(bytes(unsupported))
    assert error.value.code == 'plugin_invalid'
    (source / 'alias').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ProjectError) as error:
        package_files(source)
    assert error.value.code == 'plugin_unsafe_path'


@pytest.mark.parametrize('changes', [{'schemaVersion': 2}, {'schemaVersion': True}, {'runtimes': ['unknown']},
    {'runtimes': ['default', 'default']}, {'hooks': {'install': 'touch dangerous'}},
    {'dependencies': {'custom-brief': '1.0.0'}}, {'name': {'en-US': 'Missing Chinese'}},
    {'name': {'zh-CN': ' ', 'en-US': 'Blank Chinese'}}])
def test_invalid_manifest_never_runs_or_registers(tmp_path, changes):
    registry = PluginRegistry(tmp_path / 'workspace')
    source = custom_package(tmp_path, **changes)
    with pytest.raises(ProjectError) as error:
        registry.install(str(source))
    assert error.value.code == 'plugin_invalid'
    assert registry.catalog()['installed'] == []


def test_frontmatter_delimiters_unicode_paths_and_byte_limit(tmp_path):
    source = custom_package(tmp_path)
    entry = source / 'skills/custom-brief/SKILL.md'
    entry.write_bytes(b'---\r\nname: custom-brief\r\ndescription: "Use --- within text"\r\n---\r\nBody')
    first = package_files(zipped(source, [('skills/custom-brief/é.md', b'notes')]))
    second = package_files(zipped(source, [('skills/custom-brief/e\u0301.md', b'notes')]))
    assert first[2] == second[2]
    entry.write_text('---\nname: custom-brief\ndescription: Brief\n---\n' + '字' * 22000, encoding='utf-8')
    with pytest.raises(ProjectError) as error:
        package_files(source)
    assert error.value.code == 'plugin_invalid'


def test_broken_registry_and_failed_commit_preserve_original(tmp_path, monkeypatch):
    from opendirector.agent import plugins
    registry = PluginRegistry(tmp_path / 'workspace')
    original = registry.install('example:studio-brief')
    before = registry.path.read_bytes()
    def fail(*args):
        raise OSError('simulated disk failure')
    with monkeypatch.context() as patch:
        patch.setattr(plugins, 'write_json', fail)
        with pytest.raises(OSError):
            registry.change('studio-brief', original['digest'], runtime='default', enabled=True)
        with pytest.raises(OSError):
            registry.install(str(custom_package(tmp_path)))
    assert registry.path.read_bytes() == before
    assert registry.install(str(tmp_path / 'custom-brief'))['manifest']['id'] == 'custom-brief'
    registry.path.write_text('{broken')
    with pytest.raises(ProjectError) as error:
        registry.install('example:studio-brief')
    assert error.value.code == 'plugin_registry_invalid'
    assert registry.path.read_text() == '{broken'


def test_http_optional_installation_and_bilingual_errors(tmp_path):
    root = custom_package(tmp_path)
    with TestClient(create_app(LocalProjects(tmp_path / 'workspace')), headers=HEADERS) as client:
        assert client.get('/api/plugins', headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.post('/api/plugins', json={'source': str(root)}, headers={'X-OpenDirector-Request': ''}).status_code == 403
        installed = client.post('/api/plugins/upload', content=zipped(root), headers={'Content-Type': 'application/zip'})
        assert installed.status_code == 200, installed.text
        row = installed.json()
        assert row['enabledRuntimes'] == []
        assert client.put('/api/plugins/custom-brief/runtimes/codex', json={'digest': row['digest'], 'enabled': True}).status_code == 200
        invalid = {'digest': '0' * 64, 'enabled': False}
        english = client.put('/api/plugins/custom-brief/runtimes/codex', json=invalid)
        chinese = client.put('/api/plugins/custom-brief/runtimes/codex', json=invalid, headers={'Accept-Language': 'zh-CN'})
        assert english.status_code == chinese.status_code == 409
        assert english.json()['code'] == chinese.json()['code'] == 'plugin_changed'
        assert 'Refresh' in english.json()['detail']
        assert '刷新' in chinese.json()['detail']
        assert client.request('DELETE', '/api/plugins/custom-brief', json={'digest': row['digest']}).status_code == 200
        assert client.get('/api/plugins').json()['installed'] == []


def test_public_download_rejects_private_hosts_and_rechecks_redirects(tmp_path, monkeypatch):
    from opendirector.agent import plugins
    package = zipped(custom_package(tmp_path))
    requests = []
    mode = 'zip'
    def serve(request):
        requests.append(request)
        return httpx.Response(302, headers={'Location': 'https://127.0.0.1/private'}) if mode == 'redirect' else httpx.Response(200, stream=httpx.ByteStream(package))
    original = httpx.Client
    monkeypatch.setattr(plugins.httpx, 'Client', lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(serve)))
    assert download_package('https://8.8.8.8/package.zip') == package
    assert requests[0].headers['host'] == '8.8.8.8'
    assert 'authorization' not in requests[0].headers
    mode = 'redirect'
    with pytest.raises(ProjectError) as error:
        download_package('https://8.8.8.8/package.zip')
    assert error.value.code == 'plugin_url_unsafe'
    assert len(requests) == 2
    for url in ('http://8.8.8.8/package.zip', 'https://127.0.0.1/a', 'https://user:secret@8.8.8.8/a', 'https://[::1]/a'):
        with pytest.raises(ProjectError) as error:
            download_package(url)
        assert error.value.code == 'plugin_url_unsafe'
    assert len(requests) == 2


def test_native_skill_discovery_respects_harness_and_disable(tmp_path):
    registry = PluginRegistry(tmp_path)
    item = registry.install('example:studio-brief')
    baseline = asyncio.run(skills(tmp_path, tmp_path / 'project'))
    assert all(row['source'] != 'plugin' for row in baseline)
    registry.change('studio-brief', item['digest'], runtime='default', enabled=True)
    found = asyncio.run(skills(tmp_path, tmp_path / 'project'))
    plugin = next(row for row in found if row['name'] == 'studio-brief')
    assert plugin['source'] == 'plugin'
    assert plugin['displayName']['zh-CN'] == '创作简报'
    assert all(row['source'] != 'plugin' for row in asyncio.run(skills(tmp_path, tmp_path / 'project', 'codex')))
    registry.change('studio-brief', item['digest'], runtime='default', enabled=False)
    assert asyncio.run(skills(tmp_path, tmp_path / 'project')) == baseline


def test_plugin_change_starts_new_native_session_without_erasing_history(tmp_path):
    plugin = {'pluginId': 'studio-brief', 'pluginDigest': '1' * 64}
    run = RunContext(runtime='codex', project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, conversation_id=uuid4(), config=None, messages=[{'role': 'user', 'content': 'first'}],
        selected_skills=[], skills=[plugin])
    run.save_native_session('session-one', {})
    record = run.native_session_path() / 'session.json'
    before = record.read_bytes()
    next_run = replace(run, messages=[*run.messages, {'role': 'assistant', 'content': 'done'}, {'role': 'user', 'content': 'next'}])
    assert next_run.native_session_id({}) == 'session-one'
    assert replace(next_run, skills=[]).native_session_id({}) is None
    assert replace(next_run, skills=[{**plugin, 'pluginDigest': '2' * 64}]).native_session_id({}) is None
    assert record.read_bytes() == before


def test_uninstall_preserves_published_editable_brief(publication):
    business, run, work = publication
    registry = PluginRegistry(run.directory.parent.parent)
    item = registry.install('example:studio-brief')
    registry.change('studio-brief', item['digest'], runtime='codex', enabled=True)
    prepare_skills(work, registry.skills('codex'))
    template = work / '.agents/skills/studio-brief/templates/brief.en.md'
    content = template.read_text().replace('Describe the audience, message, intended duration and requirements supplied by the user.',
                                         'A 15-second studio introduction for new customers.')
    (work / 'brief.md').write_text(content, encoding='utf-8')
    result = asyncio.run(business.execute(run.project_id, run.turn_id, run.session, 'publish-brief',
        'execute_command', {'type': 'artifact.publish', 'payload': {'path': 'brief.md', 'name': 'Creative brief', 'expectedKind': 'text'}},
        roots=[], config=None, native_runtime='codex'))
    assert result['status'] == 'applied'
    asset_id = result['changed'][0]['id']
    saved = business.assets.get(run.project_id, asset_id)
    assert saved.kind == 'text'
    registry.change('studio-brief', item['digest'])
    assert business.assets.get(run.project_id, asset_id) == saved
    stream, _ = business.assets.open_media(run.project_id, saved.id)
    with stream:
        assert stream.read() == content.encode()
    edited = business.projects.execute(parse_command(dict(type='asset.writeText', projectId=run.project_id,
        commandId=uuid4(), payload=dict(name='Revised brief.md', text='User revision', previousAsset=asset_ref(saved).model_dump(mode='json')),
        expectedVersions=[dict(objectType='asset', id=saved.id, revision=saved.revision)])), session=run.session)
    assert edited.status == 'applied'
    revised = business.assets.get(run.project_id, edited.changed[0].id)
    assert revised.provenance.sources == (asset_ref(saved),)
    stream, _ = business.assets.open_media(run.project_id, revised.id)
    with stream:
        assert stream.read() == b'User revision'
    assert registry.skills('codex') == []


def test_plugin_cannot_shadow_builtin_skill(tmp_path):
    registry = PluginRegistry(tmp_path)
    item = registry.install(str(custom_package(tmp_path, 'character-replacement')))
    registry.change('character-replacement', item['digest'], runtime='default', enabled=True)
    with pytest.raises(ProjectError) as error:
        asyncio.run(skills(tmp_path, tmp_path / 'project'))
    assert error.value.code == 'plugin_skill_conflict'
    registry.change('character-replacement', item['digest'], runtime='default', enabled=False)
    assert any(row['source'] == 'builtin' for row in asyncio.run(skills(tmp_path, tmp_path / 'project')))


@pytest.mark.parametrize('entry', ['skills/custom-brief/sub/SKILL.md', 'skills/custom-brief/sub/skill.md',
                                  'skills/custom-brief/sub/SkIlL.Md', 'docs/SKILL.md'])
def test_package_rejects_every_extra_native_skill_entry(tmp_path, entry):
    registry = PluginRegistry(tmp_path / 'workspace')
    source = custom_package(tmp_path)
    with pytest.raises(ProjectError) as error:
        registry.install(zipped(source, [(entry, b'---\nname: character-replacement\ndescription: Hidden\n---\nHidden')]))
    assert error.value.code == 'plugin_invalid'
    assert registry.catalog()['installed'] == []


@pytest.mark.parametrize('unexpected', ['nested', 'duplicate', 'renamed', 'outside'])
def test_discovery_rejects_untracked_plugin_entries(tmp_path, monkeypatch, unexpected):
    import importlib
    discovery = importlib.import_module('opendirector.agent.skills')
    registry = PluginRegistry(tmp_path)
    item = registry.install('example:studio-brief')
    registry.change('studio-brief', item['digest'], runtime='default', enabled=True)
    entry = Path(registry.skills('default')[0]['filePath'])
    plugin = dict(name='studio-brief', description='Brief', location=str(entry))
    location = entry.parent / 'nested/SKILL.md' if unexpected == 'nested' else tmp_path / '.opendirector/skills/hidden/SKILL.md'
    location.parent.mkdir(parents=True, exist_ok=True)
    location.write_text('Untracked skill', encoding='utf-8')
    # The catalog boundary must reject a native-loader surprise independently of package validation.
    monkeypatch.setattr(PluginRegistry, 'verify', lambda *_: None)
    async def catalog(roots):
        if entry.parent.parent not in roots:
            return []
        if unexpected == 'renamed':
            return [{**plugin, 'name': 'untracked'}]
        return [plugin, plugin if unexpected == 'duplicate' else dict(name='untracked', description='Hidden', location=str(location))]
    monkeypatch.setattr(discovery, 'native_catalog', catalog)
    with pytest.raises(ProjectError) as error:
        asyncio.run(discovery.skills(tmp_path, tmp_path / 'project'))
    assert error.value.code == 'plugin_skill_conflict'


def test_local_directory_uses_canonical_root_without_accepting_package_links(tmp_path):
    source = custom_package(tmp_path)
    registry = PluginRegistry(tmp_path / 'workspace')
    item = registry.install(str(source / '..' / source.name))
    parent_alias = tmp_path / 'parent-alias'
    directory_link(parent_alias, tmp_path)
    assert registry.install(str(parent_alias / source.name))['digest'] == item['digest']
    root_alias = tmp_path / 'root-alias'
    directory_link(root_alias, source)
    with pytest.raises(ProjectError) as error:
        registry.install(str(root_alias))
    assert error.value.code == 'plugin_unsafe_path'
    directory_link(source / 'nested-link', source / 'skills')
    with pytest.raises(ProjectError) as error:
        registry.install(str(parent_alias / source.name))
    assert error.value.code == 'plugin_unsafe_path'


@pytest.mark.parametrize('damage', ['missing', 'changed', 'unreadable'])
def test_reinstall_preserves_damaged_cache_and_existing_turn_snapshot(tmp_path, monkeypatch, damage):
    from opendirector.agent import plugins
    registry = PluginRegistry(tmp_path)
    item = registry.install('example:studio-brief')
    registry.change('studio-brief', item['digest'], runtime='default', enabled=True)
    work = tmp_path / 'work'
    prepare_skills(work, registry.skills('default'))
    snapshot = work / '.agents/skills/studio-brief/SKILL.md'
    before = snapshot.read_bytes()
    cached = registry.directory / 'packages' / item['digest']
    entry = cached / 'skills/studio-brief/SKILL.md'
    if damage == 'missing':
        entry.unlink()
    elif damage == 'changed':
        entry.write_bytes(before + b'\nChanged')
    else:
        original = plugins.os.scandir
        unreadable = [True]
        def read(source):
            if not isinstance(source, int) and Path(source) == cached / 'skills/studio-brief/templates' and unreadable:
                unreadable.pop()
                raise PermissionError('Unreadable cache')
            return original(source)
        monkeypatch.setattr(plugins.os, 'scandir', read)
    registry.change('studio-brief', item['digest'])
    repaired = registry.install('example:studio-brief')
    assert repaired['enabledRuntimes'] == []
    assert package_files(cached)[2] == repaired['digest'] == item['digest']
    assert snapshot.read_bytes() == before
    preserved = list(registry.directory.glob('.damaged-*/package'))
    assert len(preserved) == 1
    saved_entry = preserved[0] / 'skills/studio-brief/SKILL.md'
    if damage == 'missing':
        assert not saved_entry.exists()
    else:
        assert saved_entry.read_bytes() == before + (b'\nChanged' if damage == 'changed' else b'')


def test_failed_cache_repair_preserves_old_files_and_can_retry(tmp_path, monkeypatch):
    from opendirector.agent import plugins
    registry = PluginRegistry(tmp_path)
    item = registry.install('example:studio-brief')
    registry.change('studio-brief', item['digest'])
    cached = registry.directory / 'packages' / item['digest']
    (cached / 'opendirector-plugin.json').write_bytes(b'Corrupt original')
    original = plugins.os.replace
    def fail_publication(source, target):
        if target == cached:
            raise OSError('Replacement failed')
        return original(source, target)
    with monkeypatch.context() as patch:
        patch.setattr(plugins.os, 'replace', fail_publication)
        with pytest.raises(OSError, match='Replacement failed'):
            registry.install('example:studio-brief')
    assert registry.catalog()['installed'] == []
    preserved = list(registry.directory.glob('.damaged-*/package/opendirector-plugin.json'))
    assert len(preserved) == 1 and preserved[0].read_bytes() == b'Corrupt original'
    assert not cached.exists()
    assert registry.install('example:studio-brief')['digest'] == item['digest']
    assert package_files(cached)[2] == item['digest']


def test_catalog_archives_template_and_wheel_install(tmp_path, monkeypatch):
    from opendirector import installation
    from opendirector.agent import plugins
    root = Path(__file__).resolve().parents[1]
    package_files(root / 'plugins/template')
    catalog = json.loads((root / 'plugins/catalog.json').read_text())
    for entry in catalog:
        archive = root / 'plugins/examples' / (entry['manifest']['id'] + '.zip')
        assert package_files(archive)[2] == entry['digest']
        assert package_files(plugin_examples() / entry['manifest']['id'])[2] == entry['digest']
    bundled = tmp_path / 'bundled'
    bundled.mkdir()
    shutil.copy(root / 'plugins/catalog.json', bundled / 'plugin-catalog.json')
    monkeypatch.setattr(installation, 'SOURCE_ROOT', None)
    monkeypatch.setattr(installation, 'BUNDLED', bundled)
    requests = []
    def download(url):
        requests.append(url)
        return (root / 'plugins/examples/studio-brief.zip').read_bytes()
    monkeypatch.setattr(plugins, 'download_package', download)
    registry = PluginRegistry(tmp_path / 'workspace')
    assert registry.catalog()['installed'] == []
    assert requests == []
    assert registry.install('example:studio-brief')['enabledRuntimes'] == []
    assert requests == [catalog[0]['url']]
    assert not (bundled / 'plugin-examples').exists()


def test_corrupt_installed_package_can_be_disabled_and_removed(tmp_path):
    registry = PluginRegistry(tmp_path)
    item = registry.install('example:studio-brief')
    registry.change('studio-brief', item['digest'], runtime='default', enabled=True)
    shutil.rmtree(registry.directory / 'packages' / item['digest'])
    with pytest.raises(ProjectError) as error:
        registry.skills('default')
    assert error.value.code == 'plugin_invalid'
    registry.change('studio-brief', item['digest'], runtime='default', enabled=False)
    before = registry.path.read_bytes()
    with pytest.raises(ProjectError):
        registry.change('studio-brief', item['digest'], runtime='default', enabled=True)
    assert registry.path.read_bytes() == before
    registry.change('studio-brief', item['digest'])
    assert registry.skills('default') == []


@pytest.mark.parametrize('runtime', ['default', 'opencode', 'codex', 'claude', 'jiuwenswarm', 'deepseek'])
def test_turn_catalog_and_disabled_selection_use_same_runtime(assistant, monkeypatch, tmp_path, runtime):
    from opendirector_api import agent
    client, path, _ = assistant
    monkeypatch.setattr(agent, 'skills', skills)
    registry = PluginRegistry(tmp_path)
    item = registry.install('example:studio-brief')
    registry.change('studio-brief', item['digest'], runtime=runtime, enabled=True)
    found = client.get(path + '/skills', params={'runtime': runtime}).json()
    assert any(row.get('pluginId') == 'studio-brief' for row in found)
    assert all('filePath' not in row and 'pluginDigest' not in row for row in found)
    accepted = []
    async def stream(self, run):
        accepted.append(run)
        yield {'type': 'delta', 'text': 'Fixture only'}
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    request = {'id': str(uuid4()), 'conversationId': client.get(path).json()['conversationId'],
               'text': 'Create a brief', 'runtime': runtime, 'skills': ['studio-brief']}
    assert client.post(path + '/turns', json=request).status_code == 200
    assert accepted[0].selected_skills == ['studio-brief']
    assert accepted[0].plugin_versions() == {'studio-brief': item['digest']}
    registry.change('studio-brief', item['digest'], runtime=runtime, enabled=False)
    assert all(row.get('pluginId') != 'studio-brief' for row in client.get(path + '/skills', params={'runtime': runtime}).json())
    for language, expected in [('en-US', 'Remove it from the message'), ('zh-CN', '从消息中移除')]:
        rejected = client.post(path + '/turns', json={**request, 'id': str(uuid4())}, headers={'Accept-Language': language})
        assert rejected.status_code == 409
        assert rejected.json()['code'] == 'agent_skill_unavailable'
        assert expected in rejected.json()['detail']
    assert len(accepted) == 1
