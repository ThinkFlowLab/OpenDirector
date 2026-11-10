"""Publish one already-decided commit and finish a pending journal on read.

The journal is written before any project file changes. ``project.json`` is the
commit point. Recovery finishes that intent; it does not choose a new command.
"""
from collections.abc import Callable

from pydantic import ValidationError

from opendirector.domain.creation.base import digest
from opendirector.domain.creation.commands import Command, CommandReceipt, ProjectEvent, command_fingerprint
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError, validate_command
from opendirector.domain.projects import ProjectError, identifier
from opendirector.infrastructure.creation_files import cleanup_staging, delete_files, install_files
from opendirector.infrastructure.creation_records import (
    CommitIntent, CommitRecord, Manifest, durable_json, object_changes,
)
from opendirector.infrastructure.directories import directory, sync_directory
from opendirector.infrastructure.local_projects import child, read_json
from opendirector.infrastructure.rename import rename_path


class CommitPublication:
    """Idempotent commit publication and journal recovery."""

    @staticmethod
    def _replay(records, command):
        record = next((item for item in records if item.command.commandId == command.commandId), None)
        if record is None:
            return None
        if record.receipt.inputFingerprint != command_fingerprint(command):
            raise ProjectError('该 commandId 已用于不同输入，请使用新的命令标识。', 409, code='command_conflict')
        return record.receipt.model_copy(deep=True)

    def replay(self, command):
        """Resolve an already committed command before reading upload handles."""
        self._await_current_warm(command.projectId)
        with self.local.transaction() as db:
            self._recover()
            return self._replay(self._load(db, command.projectId)[2], command)

    def commit(self, command: Command,
               apply: Callable[[ProjectSnapshot], ProjectSnapshot] | Callable[[ProjectSnapshot, tuple[CommitRecord, ...]], ProjectSnapshot], *,
               session=None, source='ui', files=(), deletes=(), with_history=False):
        if source not in {'ui', 'agent', 'background', 'external'}:
            raise ProjectError('无效的命令来源。')
        self._await_current_warm(command.projectId)
        with self.local.transaction() as db:
            self._recover()
            path, manifest, records = self._load(db, command.projectId)
            replay = self._replay(records, command)
            if replay:
                return replay
            before = records[0].snapshot
            if command.type == 'project.rename':
                self._closed(db, command.projectId, before)
            elif command.type == 'project.trash':
                self._closed(db, command.projectId, before, '删除')
            elif source not in {'background', 'external'}:
                # Only trusted server entrypoints select these sources. A
                # completed job must be able to save after its window closes.
                self._lease(db, command.projectId, path, session)
            issue, changed, snapshot = None, [], before
            try:
                validate_command(command, before)
                # Revalidate the whole graph, even if an internal caller used model_copy.
                draft = ProjectSnapshot.model_validate(before.model_dump(mode='json'))
                edited = apply(draft, tuple(records)) if with_history else apply(draft)
                snapshot = ProjectSnapshot.model_validate(edited.model_dump(mode='json'))
                if snapshot.project.id != before.project.id or snapshot.eventCursor != before.eventCursor:
                    raise ContractError('invalid_input', 'Services cannot replace project identity or event cursors')
                if snapshot.project.name != before.project.name and command.type != 'project.rename':
                    raise ContractError('invalid_input', 'Only the rename command can rename a project')
                changed = object_changes(before, snapshot, command)
                if command.type == 'project.rename':
                    self.local._conflict(self.root, snapshot.project.name, path)
            except ContractError as error:
                issue = error.issue
            except ValidationError as error:
                failures = error.errors(include_input=False, include_url=False, include_context=False)
                paths = ['.'.join(str(part) for part in failure['loc']) for failure in failures]
                issue = dict(code='invalid_input', field=paths[0][:200] or None,
                             message='; '.join(f"{path}: {failure['msg']}" if path else failure['msg']
                                               for path, failure in zip(paths, failures))[:500])
            except (ValueError, ProjectError) as error:
                issue = ContractError.from_error(error).issue.model_copy(update={'message': str(error)[:500]})
            if issue is not None:
                snapshot, changed = before, []
            elif changed:
                snapshot = ProjectSnapshot.model_validate({**snapshot.model_dump(), 'eventCursor': before.eventCursor + 1})
            record = self._make_record(command, manifest.head, snapshot, changed, source, issue)
            to_name = snapshot.project.name if command.type == 'project.rename' and changed else path.name
            return self._publish(CommitIntent(fromName=path.name, toName=to_name,
                                beforeFingerprint=digest(before), record=record, files=files if changed and issue is None else (),
                                deletes=deletes if changed and issue is None else ()), validated_history=True)

    @staticmethod
    def _make_record(command, head, snapshot, changed, source, issue=None):
        job_ids = tuple(item['version'].id for item in changed if item['version'].objectType == 'job' and item['change'] == 'created'
                        and next(job for job in snapshot.jobs if job.id == item['version'].id).status == 'queued')
        event = ProjectEvent(projectId=command.projectId, cursor=snapshot.eventCursor, commandId=command.commandId,
                             source=source, changed=changed, jobIds=job_ids) if changed else None
        receipt = CommandReceipt(commandId=command.commandId, projectId=command.projectId,
            inputFingerprint=command_fingerprint(command), status='rejected' if issue else 'accepted' if job_ids else 'applied' if changed else 'noop',
            changed=[item['version'] for item in changed], jobIds=job_ids, issues=[issue] if issue else [], eventCursor=snapshot.eventCursor)
        return CommitRecord(command=command, previousHead=head, snapshot=snapshot, receipt=receipt, event=event)

    def _journal(self, project_id):
        return child(directory(self.intents), f'{project_id}.json')

    def _temporary(self, intent):
        # Compact UUIDs retain both identities while keeping Windows staging
        # paths short enough for the longer application name.
        return child(self.root, f'.opendirector-creation-{intent.record.command.projectId.hex}-{intent.record.command.commandId.hex}')

    def _publish(self, intent, *, validated_history=False):
        self.intents.mkdir(exist_ok=True)
        sync_directory(self.state_dir)
        temporary = self._temporary(intent)
        if temporary.exists():
            raise ProjectError('提交临时目录已被占用，原目录未修改。', 409, code='storage_unavailable')
        journal = self._journal(intent.record.command.projectId)
        if journal.exists():
            raise ProjectError('工程已有待恢复的提交。', 409, code='storage_unavailable')
        durable_json(journal, intent.model_dump(mode='json'))
        self._checkpoint('journaled')
        self._finish(intent, validated_history=validated_history)
        return intent.record.receipt

    def _location(self, intent):
        target = child(self.root, intent.toName)
        temporary = self._temporary(intent)
        candidates = [temporary, target]
        if intent.fromName:
            candidates.append(child(self.root, intent.fromName))
        # Path.exists also accepts aliases on case-insensitive filesystems.
        existing_names = {entry.name for entry in self.root.iterdir()}
        locations = []
        for path in candidates:
            if path.name not in existing_names or not path.exists():
                continue
            directory(path)
            if any(path.samefile(other) for other in locations):
                continue
            manifest_path = child(path, 'project.json')
            if manifest_path.exists():
                manifest = self._manifest(path)
                if manifest.id == intent.record.command.projectId and manifest.head in {intent.record.previousHead, intent.record.command.commandId}:
                    locations.append(path)
            elif path == temporary and intent.fromName is None:
                # A new directory can be interrupted before its first file is
                # installed. The durable intent owns only this reserved name.
                if any(item.name not in {'commits'} and not item.name.startswith('.opendirector-') for item in path.iterdir()):
                    raise ProjectError('工程临时目录包含未知文件，已保留待检查。', 409)
                locations.append(path)
        if not locations and intent.fromName is None and not target.exists():
            temporary.mkdir()
            sync_directory(self.root)
            return temporary
        if len(locations) != 1:
            raise ProjectError('无法唯一定位待提交工程，原文件已保留。', 409, code='storage_unavailable')
        return locations[0]

    def _finish(self, intent, *, validated_history=False):
        self.local._check_root()
        path = self._location(intent)
        record = intent.record
        manifest_path = child(path, 'project.json')
        if manifest_path.exists():
            manifest = self._manifest(path)
            if manifest.head == record.previousHead:
                # Normal commits already verified ancestry under this lock.
                # Recovery still checks the full chain before publishing.
                previous = (self._record(path, manifest.head) if validated_history
                            else self._history(path, manifest)[0])
                current = previous.snapshot
                if (previous.command.commandId != manifest.head or current.project.id != manifest.id
                        or current.project.name != manifest.name or digest(current) != intent.beforeFingerprint):
                    raise ProjectError('工程在提交期间被外部修改，已阻止覆盖。', 409, code='storage_unavailable')
            elif manifest.name != record.snapshot.project.name:
                raise ProjectError('已发布清单被外部修改，已阻止覆盖。', 409, code='storage_unavailable')
        self._checkpoint('directory_ready')
        install_files(path, record.command.projectId, intent.files, self.state_dir, self._checkpoint)
        if intent.files:
            self._checkpoint('files_installed')
        commits = directory(child(path, 'commits'))
        commits.mkdir(exist_ok=True)
        sync_directory(path)
        file = child(commits, f'{record.command.commandId}.json')
        if file.exists():
            if self._record(path, record.command.commandId) != record:
                raise ProjectError('已存在不同内容的提交记录，未覆盖。', 409, code='storage_unavailable')
        else:
            durable_json(file, record.model_dump(mode='json'))
        self._checkpoint('bundle_written')
        if intent.fromName is None:
            # Install identity before exposing a newly built directory. A crash
            # immediately after the move can then locate it unambiguously.
            manifest = Manifest(id=record.command.projectId, name=record.snapshot.project.name, head=record.command.commandId)
            durable_json(child(path, 'project.json'), manifest.model_dump(mode='json'))
        target, temporary = child(self.root, intent.toName), self._temporary(intent)
        if path.name != target.name:
            self.local._conflict(self.root, target.name, path)
            if path != temporary:
                rename_path(path, temporary)
                sync_directory(self.root)
                self._checkpoint('directory_staged')
                path = temporary
            self.local._conflict(self.root, target.name, path)
            rename_path(path, target)
            sync_directory(self.root)
            path = target
        self._checkpoint('directory_moved')
        manifest = Manifest(id=record.command.projectId, name=record.snapshot.project.name, head=record.command.commandId)
        durable_json(child(path, 'project.json'), manifest.model_dump(mode='json'))
        self._checkpoint('published')
        delete_files(path, intent.deletes)
        if intent.deletes:
            self._checkpoint('files_deleted')
        self._journal(record.command.projectId).unlink()
        sync_directory(self.intents)
        self._checkpoint('finished')
        # The record just published is the new head, so the read that follows a
        # save does not need to replay and re-parse the whole chain.
        self._remember_current(path, record)
        try:
            cleanup_staging(record.command.projectId, intent.files, self.state_dir)
        except (OSError, ProjectError):
            # Publication is already durable. Retained staging can be cleaned
            # by explicit upload cancellation without resubmitting the command.
            pass

    def _recover(self):
        self._blocked, self._warnings = {}, []
        directory(self.intents)
        if not self.intents.exists():
            return
        for file in sorted(self.intents.glob('*.json')):
            try:
                project_id = identifier(file.stem)
            except ProjectError:
                self._warnings.append('发现无法识别的提交日志，文件已保留。')
                continue
            try:
                intent = CommitIntent.model_validate(read_json(child(self.intents, file.name)))
                if str(intent.record.command.projectId) != project_id:
                    raise ValueError('Journal filename differs from its project')
                self._finish(intent)
            except (OSError, ValueError, TypeError, KeyError, ProjectError):
                self._blocked[project_id] = True
                self._warnings.append(f'工程 {project_id} 的提交需要恢复，相关文件已保留。')
