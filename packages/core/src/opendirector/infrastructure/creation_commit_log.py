"""Read and cache the immutable commit chain.

Opening a project serves the head commit. Ancestry is proved by history reads
and by a bounded background warm, never by trusting a bare timestamp.
"""
import threading
from hashlib import sha256

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_records import CommitRecord
from opendirector.infrastructure.directories import directory
from opendirector.infrastructure.local_projects import child, read_json


# Every history read validates the whole commit chain, and each record holds a
# full project snapshot. The cache must fit a long project's history: below
# that, each read reparses every record from disk and holds the catalog lock
# long enough to expire sessions and interrupt running jobs.
RECORD_CACHE_ENTRIES = 4096
RECORD_CACHE_BYTES = 512 * 1024 * 1024
# Only the validated head of each open project is kept, so this stays small.
CURRENT_CACHE_ENTRIES = 16
# A head served without replaying its ancestry is validated in the background
# so the first autosave after a cold open reuses the parsed chain. At most a
# couple of warms run at once; more projects simply keep the lazy path.
WARM_CONCURRENCY = 2
WARM_ATTEMPTS = 64


def _file_signature(file):
    stat = file.stat(follow_symlinks=False)
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _head_signature(path, head, verify_bytes=False):
    """Cheap identity of a commit file, or None when it cannot be read."""
    file = child(directory(child(path, 'commits')), f'{head}.json')
    try:
        signature = _file_signature(file)
        if verify_bytes:
            content = sha256(file.read_bytes()).digest()
            if _file_signature(file) != signature:
                return None
            return (*signature, content)
        return signature
    except OSError:
        return None


class CommitLog:
    """Validated commit records, the head cache, and history queries."""

    def _record(self, path, head):
        file = child(directory(child(path, 'commits')), f'{head}.json')
        try:
            before = _file_signature(file)
            with self._cache_lock:
                cached = self._records_cache.get(file)
                if cached is not None:
                    self._records_cache.move_to_end(file)
            # On platforms with reliable change times, a rewrite changes the
            # signature (ctime/mtime/size/inode). Re-reading and re-hashing every
            # historical commit on each read cost ~13 s per history query for a
            # project with hundreds of commits, holding the catalog lock past the
            # 15 s contention budget of unrelated saves. On Windows, verify bytes
            # because the file signature can remain unchanged after a rewrite.
            if cached and cached[0] == before and not self._verify_record_bytes:
                # Private repository records are read-only. Public query
                # boundaries copy returned values, not every historical snapshot.
                return cached[1]
            if cached and cached[0] == before and cached[2] is not None:
                # Windows: ctime is creation time and mtime can be restored by
                # an outside writer, so the recorded bytes are verified too.
                content = sha256(file.read_bytes()).digest()
                if _file_signature(file) != before:
                    raise ValueError('Commit changed during read')
                if content != cached[2]:
                    raise ValueError('Commit content changed')
                return cached[1]
            raw = file.read_bytes() if self._verify_record_bytes else None
            content = sha256(raw).digest() if raw is not None else None
            if raw is not None and _file_signature(file) != before:
                raise ValueError('Commit changed during read')
            if cached and cached[0] == before and cached[2] == content:
                self._records_cache.move_to_end(file)
                return cached[1]
            if cached:
                with self._cache_lock:
                    removed = self._records_cache.pop(file, None)
                    if removed is not None:
                        self._records_cache_bytes -= removed[0][2]
            record = CommitRecord.model_validate_json(raw) if raw is not None else CommitRecord.model_validate(read_json(file))
            if _file_signature(file) != before:
                raise ValueError('Commit changed during read')
            if before[2] <= 8 * 1024 * 1024:
                with self._cache_lock:
                    # Another reader (a warm or a caught-up changes() poll) may
                    # have installed this record while we parsed it; replacing
                    # it must subtract the replaced size or the budget drifts.
                    replaced = self._records_cache.pop(file, None)
                    if replaced is not None:
                        self._records_cache_bytes -= replaced[0][2]
                    self._records_cache[file] = (before, record, content)
                    self._records_cache_bytes += before[2]
                    while len(self._records_cache) > RECORD_CACHE_ENTRIES or self._records_cache_bytes > RECORD_CACHE_BYTES:
                        _, removed = self._records_cache.popitem(last=False)
                        self._records_cache_bytes -= removed[0][2]
            return record
        except (ValueError, TypeError, KeyError, FileNotFoundError):
            raise ProjectError('工程提交记录缺失或损坏，已阻止自动覆盖。', 409, code='storage_unavailable') from None

    def _history(self, path, manifest):
        records, seen, head = [], set(), manifest.head
        while head is not None:
            if head in seen:
                raise ProjectError('工程提交历史存在循环，原文件已保留。', 409, code='storage_unavailable')
            seen.add(head)
            record = self._record(path, head)
            if record.command.commandId != head or record.snapshot.project.id != manifest.id:
                raise ProjectError('工程提交身份不一致，原文件已保留。', 409, code='storage_unavailable')
            if records:
                newer = records[-1]
                if newer.snapshot.eventCursor != record.snapshot.eventCursor + (1 if newer.event else 0):
                    raise ProjectError('工程变更游标不连续，原文件已保留。', 409, code='storage_unavailable')
            records.append(record)
            head = record.previousHead
        if (not records or records[-1].command.type != 'project.create' or records[-1].snapshot.eventCursor != 1
                or records[0].snapshot.project.name != manifest.name):
            raise ProjectError('工程提交历史与清单不一致，原文件已保留。', 409, code='storage_unavailable')
        # The chain behind this head is now proven; a head served earlier by
        # the head-only fast path may be reused by caught-up change polling.
        self._mark_validated(path, records[0].command.commandId)
        return records

    def _load(self, db, project_id):
        path, manifest = self._find(db, project_id)
        records = self._history(path, manifest)
        return path, manifest, records

    def _remember_current(self, path, record):
        signature = _head_signature(path, record.command.commandId, self._verify_record_bytes)
        if signature is None:
            return
        key = (str(path), str(record.command.commandId), signature)
        with self._cache_lock:
            self._current_cache[key] = (record, True)
            self._current_cache.move_to_end(key)
            while len(self._current_cache) > CURRENT_CACHE_ENTRIES:
                self._current_cache.popitem(last=False)

    def _mark_validated(self, path, head):
        """A full replay proved this head; caught-up polling may now trust it."""
        prefix = (str(path), str(head))
        with self._cache_lock:
            for key, value in list(self._current_cache.items()):
                if key[0] == prefix[0] and key[1] == prefix[1] and not value[1]:
                    self._current_cache[key] = (value[0], True)

    def _schedule_warm(self, path, manifest):
        """Validate the ancestry behind a head that was served without replay.

        The first autosave after a cold open replays the chain; warming it in
        the background right after the open read keeps that save cheap. The
        work is coalesced per (project, head) and bounded, never holds the
        catalog lock and never changes a read result: a failed warm just
        leaves the lazy path, and is not remembered as a successful proof.
        """
        key = (str(manifest.id), str(manifest.head))
        with self._warm_lock:
            if key in self._warming or key in self._warmed or len(self._warming) >= WARM_CONCURRENCY:
                return
            event = threading.Event()
            self._warming[key] = event
        thread = threading.Thread(target=self._warm, args=(path, manifest, key, event),
                                  name='creation-history-warm', daemon=True)
        try:
            thread.start()
        except BaseException:
            # A start failure must not leave a key that every later await waits
            # out. Anyone who already observed this event is released too.
            with self._warm_lock:
                if self._warming.get(key) is event:
                    self._warming.pop(key, None)
            event.set()
            raise

    def _await_warm(self, project_id, head, timeout=30):
        """Join validation of this head instead of replaying its chain twice.

        A warm of a different head is ignored. The wait stays outside the
        catalog lock, so a first autosave races one validation rather than
        parsing every snapshot twice at once.
        """
        if head is None:
            return
        with self._warm_lock:
            event = self._warming.get((str(project_id), str(head)))
        if event is not None:
            event.wait(timeout)

    def _await_current_warm(self, project_id, timeout=30):
        """Wait for a warm of the head this caller is about to read.

        When nothing is in flight this returns without taking the catalog
        lock. A missing project is left for the caller's own transaction.
        """
        project = str(project_id)
        with self._warm_lock:
            inflight = any(key[0] == project for key in self._warming)
        if not inflight:
            return
        try:
            head = self.head(project_id)
        except ProjectError:
            return
        self._await_warm(project_id, head, timeout)

    def _warm(self, path, manifest, key, event):
        validated = False
        try:
            self._history(path, manifest)
            validated = True
        except BaseException:
            # Reads stay correct: every path that needs the chain replays it
            # itself and reports the integrity failure there. Leaving the key
            # out of _warmed lets the next open retry a transient failure.
            pass
        finally:
            with self._warm_lock:
                if self._warming.get(key) is event:
                    self._warming.pop(key, None)
                if validated:
                    self._warmed[key] = True
                    self._warmed.move_to_end(key)
                    while len(self._warmed) > WARM_ATTEMPTS:
                        self._warmed.popitem(last=False)
            event.set()

    def _current_record(self, db, project_id, path, manifest):
        """The head commit and whether its ancestry has been replayed.

        Opening a canvas must not parse every historical snapshot: a commit
        leaves the old files alone (a commit file is immutable) and rewrites the
        manifest, so the head file signature plus the manifest decides whether
        the cached head is still current. Missing, corrupt or rewritten heads
        still fail here; ancestors are proven by commit/history/receipt/changes
        reads and by the background warm an open read schedules.
        """
        signature = _head_signature(path, manifest.head, self._verify_record_bytes)
        key = (str(path), str(manifest.head), signature)
        if signature is not None:
            with self._cache_lock:
                cached = self._current_cache.get(key)
                if cached is not None:
                    self._current_cache.move_to_end(key)
                    return cached
        record = self._record(path, manifest.head)
        if (record.command.commandId != manifest.head or record.snapshot.project.id != manifest.id
                or record.snapshot.project.name != manifest.name):
            raise ProjectError('工程提交身份不一致，原文件已保留。', 409, code='storage_unavailable')
        if record.previousHead is None:
            # A single-commit project's whole history is this record; validate
            # the creation invariants that a full replay would check.
            if record.command.type != 'project.create' or record.snapshot.eventCursor != 1:
                raise ProjectError('工程提交历史与清单不一致，原文件已保留。', 409, code='storage_unavailable')
            validated = True
        else:
            validated = False
        if signature is not None:
            with self._cache_lock:
                self._current_cache[key] = (record, validated)
                self._current_cache.move_to_end(key)
                while len(self._current_cache) > CURRENT_CACHE_ENTRIES:
                    self._current_cache.popitem(last=False)
        return record, validated

    def _current(self, db, project_id, path, manifest):
        """The head commit, reused while its file is untouched.

        Replaying and re-validating the whole chain for every read made opening
        a canvas take about a second. A commit leaves the old files alone and
        moves the head, and an outside rewrite changes the head file's
        signature, so both are noticed without trusting a bare timestamp.
        """
        return self._current_record(db, project_id, path, manifest)[0]

    def snapshot(self, project_id):
        with self.local.transaction() as db:
            self._recover()
            path, manifest = self._find(db, project_id)
            return self._current(db, project_id, path, manifest).snapshot.model_copy(deep=True)

    def head(self, project_id):
        """The current head commit, cheap enough to gate content-addressed caches.

        It skips the journal recovery that snapshot() runs: a caller only uses
        this to notice that a cached read is stale.
        """
        with self.local.transaction() as db:
            return self._find(db, project_id)[1].head

    def _read_manifest(self, project_id):
        """Resolve the current head under the catalog lock.

        Commit files are immutable once published, so the chain behind this head
        can be walked without holding the lock: a slow read only delays itself,
        not the saves and status polls that share the catalog.
        """
        with self.local.transaction() as db:
            self._recover()
            return self._find(db, project_id)

    def records(self, project_id):
        """Private commit records for read-only scans; callers must not mutate them.

        history() deep-copies every snapshot for callers that keep the records
        around. Scans that only count versions or owners would copy hundreds of
        megabytes for long histories, so they read the shared records directly.
        """
        path, manifest = self._read_manifest(project_id)
        return tuple(self._history(path, manifest))

    def history(self, project_id):
        records = self.records(project_id)
        # Private records are never mutated. Copy for the public caller after
        # releasing the global lock so large history reads do not block saves.
        return tuple(record.model_copy(deep=True) for record in records)

    def history_index(self, project_id):
        """Small detached event metadata; toolbar queries need no snapshots."""
        path, manifest = self._read_manifest(project_id)
        records = self._history(path, manifest)
        return records[0].snapshot.undoClearedThrough, tuple(dict(
            commandId=r.command.commandId, type=r.command.type,
            cursor=r.event.cursor, source=r.event.source,
            targetCommandId=getattr(r.command.payload, 'targetCommandId', None),
        ) for r in records if r.event is not None)

    def receipt(self, project_id, command_id):
        with self.local.transaction() as db:
            self._recover()
            records = self._load(db, project_id)[2]
            found = next((record.receipt for record in records if str(record.command.commandId) == str(command_id)), None)
            if found is None:
                raise ProjectError('没有该命令的已提交回执。', 404)
            return found.model_copy(deep=True)

    def changes(self, project_id, *, after=0, limit=100):
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise ProjectError('变更游标或分页大小无效。')
        # open() may already be proving this head. Joining that warm before the
        # catalog lock keeps a caught-up subscriber from replaying the same
        # chain while the lock is held.
        self._await_current_warm(project_id)
        with self.local.transaction() as db:
            self._recover()
            path, manifest = self._find(db, project_id)
            # A subscriber that is already caught up is the common polling
            # path. Replaying the commit chain here held the catalog lock for
            # about a second per poll on Windows and starved saves/heartbeats.
            head, validated = self._current_record(db, project_id, path, manifest)
            cursor = head.snapshot.eventCursor
            if after > cursor:
                raise ProjectError('变更游标超出当前工程，请重新读取快照。', 409)
            if after == cursor:
                if not validated:
                    # A head served by the fast path has not proven its ancestry
                    # yet; the outbox is derived from the chain, so validate it
                    # before claiming there are no events.
                    self._history(path, manifest)
                return dict(events=[], nextCursor=after, currentCursor=cursor, hasMore=False)
            records = self._history(path, manifest)
            events = [record.event for record in reversed(records) if record.event and record.event.cursor > after][:limit]
            events = [event.model_copy(deep=True) for event in events]
            return dict(events=events, nextCursor=events[-1].cursor if events else after,
                        currentCursor=cursor, hasMore=bool(events and events[-1].cursor < cursor))
