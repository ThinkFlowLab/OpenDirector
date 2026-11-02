"""Real filesystem commits, process interruption and file/receipt consistency."""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
from legacy_fixtures import legacy_project
from uuid import uuid4

import pytest

from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects, read_json


def request(project_id, kind='project.create', *, versions=(), **payload):
    return parse_command(dict(commandId=uuid4(), projectId=project_id, type=kind, payload=payload,
                              expectedVersions=versions))


def version(kind, object_id, revision=1):
    return dict(objectType=kind, id=object_id, revision=revision)


def create(store, name='Example'):
    command = request(uuid4(), name=name)
    receipt = store.execute(command)
    assert receipt.status == 'applied'
    return command


def rename(command, name='Renamed', revision=1):
    return request(command.projectId, 'project.rename', name=name,
                   versions=[version('project', command.projectId, revision)])


@pytest.fixture
def projects(tmp_path):
    return CreationProjects(LocalProjects(tmp_path))


def restarted(projects):
    return CreationProjects(LocalProjects(projects.local.repository))


def assert_committed(store, command, *, name, cursor):
    snapshot = store.snapshot(command.projectId)
    receipt = store.receipt(command.projectId, command.commandId)
    changes = store.changes(command.projectId)
    assert snapshot.project.name == name
    assert snapshot.eventCursor == receipt.eventCursor == changes['currentCursor'] == cursor
    assert len([event for event in changes['events'] if event.commandId == command.commandId]) == 1
    return receipt


def fail_at(store, stage):
    def checkpoint(current):
        if current == stage:
            raise OSError(f'injected crash at {stage}')
    store._checkpoint = checkpoint


def test_new_project_reopens_without_changing_existing_project_storage(projects):
    assert not projects.root.exists()
    legacy = legacy_project(projects.local)
    legacy_bytes = (Path(legacy['path']) / 'project.json').read_bytes()
    command = create(projects)
    reloaded = restarted(projects)
    assert_committed(reloaded, command, name='Example', cursor=1)
    assert reloaded.execute(command) == projects.receipt(command.projectId, command.commandId)
    assert len(reloaded.list_projects()['projects']) == 1
    assert (Path(legacy['path']) / 'project.json').read_bytes() == legacy_bytes


@pytest.mark.parametrize('stage', ['journaled', 'directory_ready', 'bundle_written', 'directory_moved', 'published', 'finished'])
def test_creation_recovers_from_each_file_commit_checkpoint(projects, stage):
    command = request(uuid4(), name='Recover me')
    fail_at(projects, stage)
    with pytest.raises(OSError):
        projects.execute(command)
    restored = restarted(projects)
    receipt = assert_committed(restored, command, name='Recover me', cursor=1)
    assert restored.execute(command) == receipt
    assert len(restored.list_projects()['projects']) == 1
    assert list(restored.intents.glob('*.json')) == []


@pytest.mark.parametrize('stage', ['journaled', 'directory_ready', 'bundle_written', 'directory_staged', 'directory_moved', 'published', 'finished'])
def test_rename_recovers_with_snapshot_receipt_and_outbox_together(projects, stage):
    original = create(projects)
    command = rename(original)
    marker = projects.root / 'Example' / 'keep.txt'
    marker.write_text('user-owned data')
    fail_at(projects, stage)
    with pytest.raises(OSError):
        projects.execute(command)
    restored = restarted(projects)
    receipt = assert_committed(restored, command, name='Renamed', cursor=2)
    assert restored.execute(command) == receipt
    assert restored.receipt(original.projectId, original.commandId).eventCursor == 1
    assert (restored.root / 'Renamed' / 'keep.txt').read_text() == 'user-owned data'
    assert not marker.exists()
    assert list(restored.intents.glob('*.json')) == []


def test_query_finishes_pending_publication_before_exposing_a_result(projects):
    created = create(projects)
    command = rename(created)
    fail_at(projects, 'bundle_written')
    with pytest.raises(OSError):
        projects.execute(command)
    # Immutable receipt bytes exist, but the old manifest still points at C1.
    manifest = read_json(projects.root / 'Example' / 'project.json')
    assert manifest['head'] == str(created.commandId)
    projects._checkpoint = lambda stage: None
    receipt = assert_committed(projects, command, name='Renamed', cursor=2)
    assert projects.execute(command) == receipt


def test_idempotency_precedes_version_and_session_checks(projects):
    created = create(projects)
    command = rename(created)
    original_receipt = projects.execute(command)
    projects.execute(rename(created, name='Third', revision=2))
    session = str(uuid4())
    projects.open(created.projectId, session)
    # Original expected revision is stale and project is currently open.
    assert projects.execute(command) == original_receipt
    assert projects.snapshot(created.projectId).project.name == 'Third'
    forged = parse_command({**command.model_dump(), 'payload': dict(name='Different')})
    with pytest.raises(ProjectError) as error:
        projects.execute(forged)
    assert error.value.status == 409 and error.value.code == 'command_conflict'
    assert projects.snapshot(created.projectId).project.name == 'Third'


def test_version_rejections_and_noops_are_durable_without_change_events(projects):
    created = create(projects)
    stale = rename(created, revision=9)
    rejected = projects.execute(stale)
    assert rejected.status == 'rejected' and rejected.issues[0].code == 'revision_conflict'
    assert projects.snapshot(created.projectId).project.revision == 1
    noop = rename(created, name='Example')
    assert projects.execute(noop).status == 'noop'
    projects.execute(rename(created))
    again = restarted(projects)
    assert again.execute(stale) == rejected
    assert len(again.changes(created.projectId)['events']) == 2
    assert again.receipt(created.projectId, noop.commandId).eventCursor == 1


@pytest.mark.parametrize('name', ['', '../escape', 'CON', 'a:b', 'abc.', '.opendirector-reserved'])
def test_invalid_creation_names_never_write_a_journal_or_project(projects, name):
    # Empty names already fail at the contract boundary.
    with pytest.raises((ProjectError, ValueError)):
        projects.execute(request(uuid4(), name=name))
    assert not projects.root.exists()
    assert not projects.intents.exists()


def test_name_conflicts_and_case_only_renames_preserve_files(projects):
    original = create(projects, 'Film')
    create(projects, 'Existing')
    assert projects.execute(rename(original, 'existing')).status == 'rejected'
    with pytest.raises(ProjectError):
        create(projects, 'film')
    assert projects.execute(rename(original, 'film')).status == 'applied'
    assert sorted(path.name for path in projects.root.iterdir()) == ['Existing', 'film']
    assert projects.snapshot(original.projectId).project.name == 'film'


def test_leases_expiry_external_moves_and_closed_rename_guards(projects):
    created = create(projects)
    session, other = str(uuid4()), str(uuid4())
    projects.open(created.projectId, session)
    with pytest.raises(ProjectError, match='其他窗口'):
        projects.open(created.projectId, other)
    with pytest.raises(ProjectError, match='关闭'):
        projects.execute(rename(created))
    (projects.root / 'Example').rename(projects.root / 'Moved outside app')
    with pytest.raises(ProjectError, match='应用外改名'):
        projects.heartbeat(session, created.projectId)
    projects.local.release(session)
    projects.open(created.projectId, other)
    with projects.local.transaction() as db:
        db.execute('UPDATE sessions SET expires=0')
    assert projects.execute(rename(created)).status == 'applied'
    assert projects.snapshot(created.projectId).project.name == 'Renamed'


def test_duplicate_ids_unknown_projects_and_legacy_formats_are_rejected(projects):
    legacy = legacy_project(projects.local)
    legacy_before = (Path(legacy['path']) / 'project.json').read_bytes()
    with pytest.raises(ProjectError) as error:
        projects.snapshot(legacy['id'])
    assert error.value.code == 'unsupported_format'
    with pytest.raises(ProjectError):
        projects.execute(request(legacy['id'], name='Take over'))
    assert (Path(legacy['path']) / 'project.json').read_bytes() == legacy_before
    with pytest.raises(ProjectError) as error:
        projects.snapshot(uuid4())
    assert error.value.status == 404
    created = create(projects)
    shutil.copytree(projects.root / 'Example', projects.root / 'Copy')
    assert not projects.list_projects()['projects']
    with pytest.raises(ProjectError, match='同标识'):
        projects.snapshot(created.projectId)


def test_future_format_is_not_overwritten_or_read_as_an_empty_project(projects):
    created = create(projects)
    file = projects.root / 'Example' / 'project.json'
    raw = read_json(file)
    raw['formatVersion'] = 99
    file.write_text(json.dumps(raw))
    before = file.read_bytes()
    with pytest.raises(ProjectError) as error:
        projects.execute(rename(created))
    assert error.value.code == 'unsupported_format'
    assert file.read_bytes() == before


def test_unrecoverable_commit_blocks_queries_but_preserves_other_projects(projects):
    created = create(projects)
    other = create(projects, 'Other')
    command = rename(created)
    fail_at(projects, 'journaled')
    with pytest.raises(OSError):
        projects.execute(command)
    # External modification after the durable intent must never be overwritten.
    head = projects.root / 'Example' / 'commits' / f'{created.commandId}.json'
    data = read_json(head)
    data['snapshot']['project']['revision'] = 2
    head.write_text(json.dumps(data))
    before = head.read_bytes()
    restored = restarted(projects)
    for read in [lambda: restored.snapshot(created.projectId),
                 lambda: restored.receipt(created.projectId, command.commandId),
                 lambda: restored.changes(created.projectId)]:
        with pytest.raises(ProjectError) as error:
            read()
        assert error.value.code == 'storage_unavailable'
    assert head.read_bytes() == before
    assert restored.snapshot(other.projectId).project.name == 'Other'
    assert len(restored.list_projects()['projects']) == 1
    assert restored.list_projects()['warnings']


def test_corrupt_journal_is_retained_without_exposing_a_partial_snapshot(projects):
    created = create(projects)
    command = rename(created)
    fail_at(projects, 'journaled')
    with pytest.raises(OSError):
        projects.execute(command)
    journal = projects.intents / f'{created.projectId}.json'
    journal.write_text('{broken')
    restored = restarted(projects)
    with pytest.raises(ProjectError):
        restored.snapshot(created.projectId)
    assert journal.read_text() == '{broken'
    assert (projects.root / 'Example').is_dir()


def test_destination_appearing_during_recovery_is_never_overwritten(projects):
    command = request(uuid4(), name='New')
    fail_at(projects, 'bundle_written')
    with pytest.raises(OSError):
        projects.execute(command)
    target = projects.root / 'New'
    target.mkdir()
    marker = target / 'keep'
    marker.write_text('external directory')
    restored = restarted(projects)
    with pytest.raises(ProjectError):
        restored.snapshot(command.projectId)
    assert marker.read_text() == 'external directory'
    marker.unlink()
    target.rmdir()
    assert restored.snapshot(command.projectId).project.name == 'New'


def test_symlinks_and_missing_commit_records_are_not_followed_or_replaced(projects, tmp_path):
    created = create(projects)
    commits = projects.root / 'Example' / 'commits'
    file = commits / f'{created.commandId}.json'
    outside = tmp_path / 'outside.json'
    outside.write_bytes(file.read_bytes())
    file.unlink()
    file.symlink_to(outside)
    with pytest.raises(ProjectError, match='符号链接'):
        projects.snapshot(created.projectId)
    file.unlink()
    with pytest.raises(ProjectError, match='缺失或损坏'):
        projects.snapshot(created.projectId)
    assert json.loads(outside.read_text())['receipt']['status'] == 'applied'


@pytest.mark.parametrize('change', ['in_place', 'replacement', 'missing'])
@pytest.mark.skipif(os.name == 'nt', reason='Commit signature caching requires POSIX change time')
def test_cached_history_still_detects_changed_ancestor_with_same_size_and_mtime(projects, monkeypatch, change):
    from opendirector.infrastructure import creation_projects as module
    created = create(projects)
    projects.execute(rename(created))
    projects.snapshot(created.projectId)
    reads = []
    original = module.read_json
    def reading(path):
        if path.parent.name == 'commits':
            reads.append(path)
        return original(path)
    monkeypatch.setattr(module, 'read_json', reading)
    assert projects.snapshot(created.projectId).project.name == 'Renamed'
    assert reads == []  # Validated records are reused, but every file is still checked.
    ancestor = projects.root / 'Renamed' / 'commits' / f'{created.commandId}.json'
    stat = ancestor.stat()
    if change == 'missing':
        ancestor.unlink()
    else:
        damaged = ancestor.read_bytes().replace(b'Example', b'Corrupt', 1)
        assert len(damaged) == stat.st_size
        if change == 'replacement':
            temporary = ancestor.with_suffix('.tmp')
            temporary.write_bytes(damaged)
            temporary.replace(ancestor)
        else:
            ancestor.write_bytes(damaged)
        os.utime(ancestor, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    with pytest.raises(ProjectError, match='缺失或损坏'):
        projects.snapshot(created.projectId)


@pytest.mark.skipif(os.name == 'nt', reason='Commit signature caching requires POSIX change time')
def test_long_history_is_validated_from_disk_only_once(projects, monkeypatch):
    # Each read validates the whole chain; a cache smaller than the history
    # would reparse every record on every read of a long project.
    from opendirector.infrastructure import creation_projects as module
    created = create(projects)
    for revision in range(1, 200):
        assert projects.execute(rename(created, f'Renamed {revision}', revision)).status == 'applied'
    projects.snapshot(created.projectId)
    reads = []
    original = module.read_json
    def reading(path):
        if path.parent.name == 'commits':
            reads.append(path)
        return original(path)
    monkeypatch.setattr(module, 'read_json', reading)
    assert projects.snapshot(created.projectId).project.name == 'Renamed 199'
    assert reads == []


def test_returned_snapshots_and_history_cannot_mutate_record_cache(projects):
    created = create(projects)
    session = str(uuid4())
    projects.open(created.projectId, session)
    operation = request(created.projectId, 'editor.create', document=dict(
        id=uuid4(), projectId=created.projectId, kind='media_edit',
        data=dict(tool='image-hd', parameters={'scale': 2})))
    assert projects.execute(operation, session=session).status == 'applied'
    projects.snapshot(created.projectId).editorDocuments[0].data.parameters['scale'] = 99
    projects.history(created.projectId)[0].snapshot.editorDocuments[0].data.parameters['scale'] = 88
    projects.open(created.projectId, session).editorDocuments[0].data.parameters['scale'] = 77
    assert projects.snapshot(created.projectId).editorDocuments[0].data.parameters == {'scale': 2}


def test_storage_commit_checks_object_versions_and_replays_without_rerunning_service(projects):
    created = create(projects)
    session = str(uuid4())
    projects.open(created.projectId, session)
    item_id = uuid4()
    item = dict(id=item_id, projectId=created.projectId, kind='image', binding=dict(role='empty'))
    command = request(created.projectId, 'canvas.show', item=item)
    calls = []
    def apply(snapshot):
        calls.append(1)
        return ProjectSnapshot.model_validate({**snapshot.model_dump(), 'canvasItems': [item]})
    receipt = projects.commit(command, apply, session=session)
    assert receipt.changed[0].objectType == 'canvas_item'
    projects.local.release(session)
    assert projects.commit(command, apply) == receipt
    assert calls == [1]
    projects.open(created.projectId, session)
    stale = request(created.projectId, 'canvas.hide', itemId=item_id, versions=[version('canvas_item', item_id)])
    def invalid_revision(snapshot):
        data = snapshot.model_dump()
        data['canvasItems'][0]['visible'] = False
        return ProjectSnapshot.model_validate(data)
    assert projects.commit(stale, invalid_revision, session=session).issues[0].code == 'revision_conflict'
    assert projects.snapshot(created.projectId).canvasItems[0].visible


def test_concurrent_same_revision_commands_have_one_winner(projects):
    created = create(projects)
    commands = [rename(created, 'First'), rename(created, 'Second')]
    def execute(command):
        return CreationProjects(LocalProjects(projects.local.repository)).execute(command)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(execute, commands))
    assert sorted(result.status for result in results) == ['applied', 'rejected']
    assert projects.snapshot(created.projectId).project.revision == 2
    assert len(projects.changes(created.projectId)['events']) == 2


def test_paginated_outbox_has_no_duplicate_or_skipped_events(projects):
    created = create(projects)
    for revision in range(1, 4):
        projects.execute(rename(created, f'Name {revision}', revision=revision))
    first = projects.changes(created.projectId, limit=2)
    second = projects.changes(created.projectId, after=first['nextCursor'], limit=2)
    assert [event.cursor for event in [*first['events'], *second['events']]] == [1, 2, 3, 4]
    assert first['hasMore'] and not second['hasMore']
    assert not projects.changes(created.projectId, after=4)['events']
    with pytest.raises(ProjectError):
        projects.changes(created.projectId, after=5)


@pytest.mark.parametrize('file_kind', ['journal', 'bundle', 'manifest'])
def test_real_file_write_failure_preserves_recoverable_intent(projects, monkeypatch, file_kind):
    from opendirector.infrastructure import creation_projects
    created = create(projects)
    command = rename(created)
    original = creation_projects.write_json
    def fail_write(path, value):
        matches = (path.parent == projects.intents if file_kind == 'journal' else
                   path.name == f'{command.commandId}.json' if file_kind == 'bundle' else path.name == 'project.json')
        if matches:
            raise OSError('simulated disk full')
        original(path, value)
    monkeypatch.setattr(creation_projects, 'write_json', fail_write)
    with pytest.raises(OSError):
        projects.execute(command)
    monkeypatch.setattr(creation_projects, 'write_json', original)
    restored = restarted(projects)
    if file_kind == 'journal':
        assert restored.snapshot(created.projectId).project.name == 'Example'
        with pytest.raises(ProjectError) as error:
            restored.receipt(created.projectId, command.commandId)
        assert error.value.status == 404
    else:
        assert_committed(restored, command, name='Renamed', cursor=2)
    assert restored.execute(command).status == 'applied'


def test_active_jobs_prevent_rename_and_background_completion_survives_closed_window(projects):
    fixture = json.loads((Path(__file__).parent / 'fixtures/creation-project.json').read_text())
    created = request(fixture['project']['id'], name=fixture['project']['name'])
    projects.execute(created)
    session = str(uuid4())
    projects.open(created.projectId, session)
    fixture['assets'] = [asset for asset in fixture['assets'] if asset['provenance']['source'] != 'generated']
    fixture['results'] = []
    fixture['generationSpecs'][0]['currentResultId'] = None
    fixture['jobs'][0].update(status='queued', phase='queued', asset=None, recovery='submit')
    fixture['eventCursor'] = 1
    seed = request(created.projectId, 'generationSpec.create', spec=fixture['generationSpecs'][0])
    receipt = projects.commit(seed, lambda before: ProjectSnapshot.model_validate(fixture), session=session)
    assert receipt.status == 'accepted' and len(receipt.jobIds) == 1
    projects.local.release(session)
    with pytest.raises(ProjectError, match='生成素材'):
        projects.execute(rename(created))
    job_id = fixture['jobs'][0]['id']
    completed = request(created.projectId, 'job.cancel', jobId=job_id, versions=[version('job', job_id)])
    def cancel(before):
        data = before.model_dump()
        data['jobs'][0].update(status='cancelled', revision=2, cancelRequested=True)
        return ProjectSnapshot.model_validate(data)
    # A client source cannot bypass the closed session.
    with pytest.raises(ProjectError, match='会话'):
        projects.commit(completed, cancel)
    assert projects.commit(completed, cancel, source='background').status == 'applied'
    assert projects.changes(created.projectId)['events'][-1].source == 'background'
    assert projects.execute(rename(created)).status == 'applied'


def test_unversioned_internal_writes_and_unknown_schema_versions_preserve_prior_state(projects):
    created = create(projects)
    command = request(created.projectId, 'asset.writeText', name='text.txt', text='text')
    def wrong_scope(before):
        data = before.model_dump()
        data['project']['revision'] = 2
        return ProjectSnapshot.model_validate(data)
    rejected = projects.commit(command, wrong_scope, source='background')
    assert rejected.status == 'rejected' and rejected.issues[0].code == 'revision_conflict'
    assert projects.snapshot(created.projectId).project.revision == 1
    file = projects.root / 'Example' / 'commits' / f'{command.commandId}.json'
    raw = read_json(file)
    raw['schemaVersion'] = 99
    file.write_text(json.dumps(raw))
    with pytest.raises(ProjectError, match='缺失或损坏'):
        projects.snapshot(created.projectId)
