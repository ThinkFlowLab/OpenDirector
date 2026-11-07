"""File-authoritative creation projects, using LocalProjects coordination.

An immutable commit contains the snapshot, command receipt and outbox event.
A durable intent precedes every filesystem mutation. Publishing project.json
is the commit point; reads first finish pending intents under the catalog lock.
SQLite coordinates leases only and is never used to roll back file writes.

Catalog scans, commit history, and publication live in sibling modules.
Command dispatch lives in ``application.creation_commands``. ``execute`` delegates
there so this module does not import application services.
"""
import os
import threading
import time
from collections import OrderedDict
from uuid import UUID

from opendirector.domain.creation.base import digest
from opendirector.domain.creation.commands import Command
from opendirector.domain.creation.index import object_index
from opendirector.domain.creation.project import Project, ProjectSnapshot, ViewState
from opendirector.domain.creation.validation import ContractError, validate_command
from opendirector.domain.projects import ProjectError, identifier, project_name
from opendirector.infrastructure import recycle
from opendirector.infrastructure.creation_catalog import ProjectCatalog
from opendirector.infrastructure.creation_commit_log import CommitLog
from opendirector.infrastructure.creation_publication import CommitPublication
from opendirector.infrastructure.creation_records import CommitIntent, CommitRecord, durable_json, object_changes
from opendirector.infrastructure.directories import directory, sync_directory
from opendirector.infrastructure.local_projects import LocalProjects, child, read_json
from opendirector.ports.dispatch import command_dispatcher


__all__ = [
    'CommitRecord',
    'CreationProjects',
    'directory',
    'durable_json',
    'object_index',
    'sync_directory',
]


class CreationProjects(ProjectCatalog, CommitLog, CommitPublication):
    """Authoritative repository for project commits and lifecycle storage.

    commit() is an internal application-service boundary;
    untrusted clients cannot supply a callback or replace an entire snapshot.
    Command routing lives in application.creation_commands. execute() delegates
    there so this module does not import application services.
    """

    def __init__(self, local: LocalProjects):
        self.local = local
        self.root = local.root
        self.state_dir = directory(local.state_dir)
        self.intents = directory(child(self.state_dir, 'creation-commits'))
        self._blocked = {}
        self._warnings = []
        self._invalid = []
        self._records_cache = OrderedDict()
        self._records_cache_bytes = 0
        # Windows ctime is creation time. Verify bytes there before reusing a
        # parsed record, including when an external writer restores its mtime.
        self._verify_record_bytes = os.name == 'nt'
        # (path, head, file signature) -> (record, chain validated). A head
        # served by the fast path is validated when history is next replayed.
        self._current_cache: "OrderedDict[tuple, tuple[CommitRecord, bool]]" = OrderedDict()
        # Reads arrive on several threads; both caches are only touched here.
        self._cache_lock = threading.Lock()
        self._warm_lock = threading.Lock()
        # (project id, head) -> Event. A save waits only for the head it will read.
        self._warming = {}
        # (project id, head) -> True after that head's ancestry was proved.
        # A failed attempt is absent so the next open can try again.
        self._warmed = OrderedDict()
        with local.transaction():
            self._recover()

    def _checkpoint(self, stage):
        """Fault-injection boundary. Never participates in production decisions."""

    def _lease(self, db, project_id, path, session):
        if session is None:
            raise ProjectError('修改工程需要已打开的会话。', 409)
        identifier(session)
        lease = db.execute('SELECT path FROM sessions WHERE id=? AND project_id=? AND expires>?',
                           (session, str(project_id), time.time())).fetchone()
        if lease is None:
            raise ProjectError('工程已关闭或会话已过期，请重新打开后保存。', 409)
        if lease['path'] != str(path):
            raise ProjectError('工程目录已在应用外改名或移动，请复制未保存内容并重新打开。', 409)

    def _closed(self, db, project_id, snapshot, verb='重命名'):
        if db.execute('SELECT 1 FROM sessions WHERE project_id=? AND expires>?', (str(project_id), time.time())).fetchone():
            raise ProjectError(f'请先保存并关闭工程后再{verb}。', 409)
        if any(job.status in {'queued', 'running'} for job in snapshot.jobs):
            raise ProjectError(f'工程仍在生成素材，请等待或取消任务后再{verb}。', 409)
        path, _ = self._find(db, project_id)
        tools = child(path, 'tool-tasks')
        if tools.exists() and any(read_json(child(tools, item.name)).get('status') in {'queued', 'running'} for item in tools.glob('*.json')):
            raise ProjectError(f'工程仍有工具任务，请等待或取消任务后再{verb}。', 409)

    def view(self, project_id, client_id, value=None, *, session=None, missing_ok=False):
        with self.local.transaction() as db:
            self._recover()
            path, _ = self._find(db, project_id)
            folder = directory(child(path, 'views'))
            file = child(folder, f'{UUID(str(client_id))}.json')
            if value is not None:
                self._lease(db, project_id, path, session)
                value = ViewState.model_validate(value)
                if str(value.projectId) != str(project_id) or str(value.clientId) != str(client_id):
                    raise ProjectError('视图不属于当前工程或客户端。')
                folder.mkdir(exist_ok=True)
                durable_json(file, value.model_dump(mode='json'))
                return value
            if file.exists():
                return ViewState.model_validate(read_json(file))
            return None if missing_ok else ViewState(projectId=project_id, clientId=client_id)

    def open(self, project_id, session):
        with self.local.transaction() as db:
            self._recover()
            path, manifest = self._find(db, project_id)
            self.local._open(db, dict(id=str(project_id), path=str(path)), session)
            record, validated = self._current_record(db, project_id, path, manifest)
            if not validated:
                # The canvas is open now; prove the ancestry in the background
                # so the first autosave does not replay it under the lock.
                self._schedule_warm(path, manifest)
            return record.snapshot.model_copy(deep=True)

    def heartbeat(self, session, project_id):
        self.open(project_id, session)

    def execute(self, command: Command, *, session=None, source='ui', imported_from=None):
        return command_dispatcher().execute(
            self, command, session=session, source=source, imported_from=imported_from)

    def _create(self, command, source):
        name = project_name(command.payload.name)
        with self.local.transaction() as db:
            self._recover()
            grouped, _, _, _, _ = self._scan()
            if str(command.projectId) in self._blocked:
                self._find(db, command.projectId)
            if str(command.projectId) in grouped:
                records = self._load(db, command.projectId)[2]
                replay = self._replay(records, command)
                if replay:
                    return replay
                raise ProjectError('该工程标识已经使用。', 409, code='command_conflict')
            if command.expectedVersions:
                raise ProjectError('新工程不能声明已有对象版本。')
            self.root.mkdir(exist_ok=True)
            sync_directory(self.root.parent)
            self.local._conflict(self.root, name)
            snapshot = ProjectSnapshot(project=Project(id=command.projectId, name=name), eventCursor=1)
            changed = object_changes(None, snapshot, command)
            record = self._make_record(command, None, snapshot, changed, source)
            return self._publish(CommitIntent(fromName=None, toName=name, beforeFingerprint=None, record=record))

    @property
    def delete_mode(self) -> str:
        """How a removed project leaves the disk, for the confirmation prompt."""
        return 'recycle_bin' if recycle.recyclable(self.root) else 'permanent'

    def _trash(self, command, source):
        """Remove the project directory without rewriting its history.

        Deleting a canvas used to publish a throwaway no-op commit first, which
        replayed the whole chain and then wrote into the directory it was about
        to remove.

        Accepted delete: the receipt is returned to the caller and is not
        committed. The directory is removed after the catalog lock is released,
        so a later ``project.trash`` with the same commandId cannot replay that
        receipt and resolves as 404. The workspace treats that 404 as success
        because the project it listed is already gone. The CLI reports the 404:
        a missing project id must not look like a completed delete, and there
        is no stored receipt to return.

        Rejected delete (stale revision or another validation failure): the
        directory is kept, so the receipt is published. Publishing replays the
        chain first. A head-only read is not marked validated, and a corrupt
        ancestor fails before any journal is written.

        The directory is recycled when the platform supports it and removed
        permanently otherwise; `delete_mode` tells the client which one the user
        is agreeing to.
        """
        if source not in {'ui', 'agent', 'background', 'external'}:
            raise ProjectError('无效的命令来源。')
        with self.local.transaction() as db:
            self._recover()
            path, manifest = self._find(db, command.projectId)
            commits = directory(child(path, 'commits'))
            # Command IDs are unique per project; an existing commit file is the
            # idempotent replay, so this needs no chain replay.
            existing = child(commits, f'{command.commandId}.json')
            if existing.exists():
                replay = self._replay((self._record(path, command.commandId),), command)
                if replay:
                    return replay
                raise ProjectError('该 commandId 已用于不同输入，请使用新的命令标识。', 409, code='command_conflict')
            record, _ = self._current_record(db, command.projectId, path, manifest)
            before = record.snapshot
            self._closed(db, command.projectId, before, '删除')
            issue = None
            try:
                validate_command(command, before)
            except ContractError as error:
                issue = error.issue
            except (ValueError, ProjectError) as error:
                issue = dict(code='invalid_input', message=str(error)[:500])
            if issue is not None:
                # Publishing a rejected receipt moves the head and marks it
                # validated, and a journal left by a failed publication would
                # block later deletions. Prove the ancestry this head-only read
                # did not inspect before writing anything.
                self._history(path, manifest)
                rejected = self._make_record(command, manifest.head, before, [], source, issue)
                return self._publish(CommitIntent(
                    fromName=path.name, toName=path.name, beforeFingerprint=digest(before), record=rejected),
                    validated_history=True)
            receipt = self._make_record(command, manifest.head, before, [], source).receipt
            db.execute('DELETE FROM sessions WHERE project_id=?', (str(command.projectId),))
        try:
            recycle.remove(path, recoverable=self.delete_mode == 'recycle_bin')
        except OSError as error:
            raise ProjectError(str(error), 409, code='storage_unavailable') from error
        sync_directory(self.root)
        return receipt
