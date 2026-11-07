"""Project directory scan, catalog listing, and unreadable-folder cleanup."""
import time
from pathlib import Path

from opendirector.domain.projects import ProjectError, identifier, project_name
from opendirector.infrastructure import recycle
from opendirector.infrastructure.creation_records import Manifest
from opendirector.infrastructure.directories import directory, sync_directory
from opendirector.infrastructure.local_projects import child, read_json


class ProjectCatalog:
    """Find project directories and list the ones a catalog read can open."""

    @staticmethod
    def _parse_manifest(raw):
        if not isinstance(raw, dict) or raw.get('format') != 'opendirector-project' or raw.get('formatVersion') != 2:
            raise ProjectError('不支持该工程格式；请创建新工程，旧文件不会自动转换。', 409, code='unsupported_format')
        try:
            value = Manifest.model_validate(raw)
            project_name(value.name)
            return value
        except (ValueError, TypeError):
            raise ProjectError('工程清单无效，原文件已保留。', 409, code='storage_unavailable') from None

    @classmethod
    def _manifest(cls, path):
        directory(path)
        return cls._parse_manifest(read_json(child(path, 'project.json')))

    def _scan(self):
        self.local._check_root()
        grouped, manifests, unsupported, warnings = {}, {}, set(), list(self._warnings)
        self._invalid = []
        if self.root.is_dir():
            for path in sorted(self.root.iterdir()):
                if path.is_symlink() or not path.is_dir() or path.name.startswith('.opendirector-'):
                    continue
                manifest_path = path / 'project.json'
                if not manifest_path.exists() and not manifest_path.is_symlink():
                    continue
                try:
                    project_name(path.name)
                    raw = read_json(child(path, 'project.json'))
                    project_id = identifier(raw['id'])
                    grouped.setdefault(project_id, []).append(path)
                    if raw.get('format') != 'opendirector-project' or raw.get('formatVersion') != 2:
                        unsupported.add(project_id)
                    else:
                        # Parsed once per scan; callers never reread project.json.
                        manifests[project_id] = raw
                except (OSError, ValueError, TypeError, KeyError, ProjectError):
                    warning = f'工程“{path.name}”的清单无法读取，原文件已保留。'
                    warnings.append(warning)
                    self._invalid.append((path, warning))
        conflicts = {key for key, paths in grouped.items() if len(paths) > 1}
        for key in sorted(conflicts):
            warnings.append(f'工程标识重复：{key}；请移走重复目录后重试。')
        return grouped, manifests, unsupported, conflicts, warnings

    def _find(self, db, project_id):
        project_id = identifier(str(project_id))
        if project_id in self._blocked:
            raise ProjectError('工程提交需要恢复；请检查磁盘及工程文件后重试。', 409, code='storage_unavailable')
        grouped, manifests, unsupported, conflicts, _ = self._scan()
        if project_id in conflicts:
            raise ProjectError('projects 中存在同标识工程，请移走重复目录后重试。', 409)
        if project_id in unsupported:
            raise ProjectError('不支持该工程格式；请创建新工程，旧文件不会自动转换。', 409, code='unsupported_format')
        if project_id not in grouped:
            raise ProjectError('工程不在 projects 中或清单无法读取，请刷新工程列表。', 404)
        path = grouped[project_id][0]
        raw = manifests.get(project_id)
        if raw is None:
            # The manifest is present but invalid; report the precise reason.
            return path, self._manifest(path)
        return path, self._parse_manifest(raw)

    @staticmethod
    def _unreadable_item(path, reason, project_id=None):
        return dict(id=project_id, name=path.name, path=str(path), reason=reason)

    def _catalog(self, db):
        # One directory scan for the whole listing: resolving each project with
        # _find() reread every project.json once per project (O(N^2)).
        grouped, manifests, unsupported, conflicts, warnings = self._scan()
        invalid = list(self._invalid)
        projects = []
        unreadable = [self._unreadable_item(path, reason) for path, reason in invalid]
        for project_id in sorted(grouped):
            paths = grouped[project_id]
            if project_id in unsupported:
                reason = f'工程 {project_id} 使用旧格式，统一工程接口不支持读取或转换。'
                warnings.append(reason)
                unreadable.extend(self._unreadable_item(path, reason, project_id) for path in paths)
                continue
            if project_id in conflicts:
                reason = f'工程标识重复：{project_id}；请移走重复目录后重试。'
                unreadable.extend(self._unreadable_item(path, reason, project_id) for path in paths)
                continue
            try:
                if project_id in self._blocked:
                    raise ProjectError('工程提交需要恢复；请检查磁盘及工程文件后重试。',
                                       409, code='storage_unavailable')
                path = paths[0]
                raw = manifests.get(project_id)
                manifest = self._manifest(path) if raw is None else self._parse_manifest(raw)
                # Parsing the head alone proves the project still opens, and the
                # manifest already carries the name it must agree with; a full
                # chain replay just to list a name cost about a second.
                record = self._record(path, manifest.head)
                if record.snapshot.project.name != manifest.name:
                    raise ProjectError('工程提交历史与清单不一致，原文件已保留。', 409, code='storage_unavailable')
                projects.append(dict(id=project_id, name=manifest.name, path=str(path)))
            except (ProjectError, OSError):
                reason = f'工程 {project_id} 需要恢复，原文件已保留。'
                warnings.append(reason)
                unreadable.append(self._unreadable_item(paths[0], reason, project_id))
        projects.sort(key=lambda item: (item['name'].casefold(), item['name']))
        unreadable.sort(key=lambda item: (item['name'].casefold(), item['name']))
        return dict(projects=projects, unreadable=unreadable, warnings=warnings)

    def list_projects(self):
        with self.local.transaction() as db:
            self._recover()
            return self._catalog(db)

    @staticmethod
    def _cleanup_blocker(db, project_id, path):
        active = db.execute('SELECT 1 FROM sessions WHERE expires>? AND (path=? OR project_id=?)',
                            (time.time(), str(path), project_id or '')).fetchone()
        if active:
            return '工程仍在其他窗口中打开，请关闭后再清理。'
        tools = path / 'tool-tasks'
        if tools.exists() or tools.is_symlink():
            try:
                directory(tools)
                tasks = [read_json(child(tools, item.name)) for item in tools.glob('*.json')]
                if any(not isinstance(task, dict) for task in tasks):
                    raise ValueError('Invalid tool task')
            except (OSError, ValueError, TypeError, KeyError, ProjectError):
                return '无法确认工具任务状态，请检查工程文件后再清理。'
            if any(task.get('status') in {'queued', 'running'} for task in tasks):
                return '工程仍有工具任务，请等待或取消任务后再清理。'
        return None

    def cleanup_unreadable(self):
        """Remove only directories that a fresh catalog read still cannot open."""
        with self.local.transaction() as db:
            self._recover()
            candidates = self._catalog(db)['unreadable']
        removed, failed = [], []
        for candidate in candidates:
            with self.local.transaction() as db:
                self._recover()
                current = next((item for item in self._catalog(db)['unreadable']
                                if item['path'] == candidate['path']), None)
                if current is None:
                    continue
                path = Path(current['path'])
                blocker = self._cleanup_blocker(db, current['id'], path)
            if blocker:
                failed.append(dict(name=current['name'], message=blocker))
                continue
            if not path.exists() and not path.is_symlink():
                continue
            try:
                directory(path)
                recycle.remove(path, recoverable=self.delete_mode == 'recycle_bin')
            except (OSError, ProjectError) as error:
                failed.append(dict(name=current['name'], message=str(error)))
                continue
            removed.append(current['name'])
            if current['id']:
                journal = self._journal(current['id'])
                if journal.exists():
                    # The project is gone; its pending recovery must not recreate
                    # a permanent catalog warning on the next read.
                    journal.unlink()
                    sync_directory(self.intents)
            with self.local.transaction() as db:
                db.execute('DELETE FROM sessions WHERE path=?', (str(path),))
                if current['id']:
                    db.execute('DELETE FROM sessions WHERE project_id=?', (current['id'],))
        if removed:
            sync_directory(self.root)
        return dict(removed=removed, failed=failed)
