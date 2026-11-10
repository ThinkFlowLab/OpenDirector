"""Local catalog lock and edit leases; project facts live in creation commits."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time

from filelock import FileLock
from opendirector.domain.projects import ProjectError, identifier

def child(directory: Path, name: str) -> Path:
    path = directory / name
    if path.is_symlink():
        raise ProjectError("项目内部文件不能是符号链接。", 409)
    return path


def read_json(path: Path):
    path = Path(_json_path(path))
    if path.is_symlink():
        raise ProjectError("不能读取符号链接项目文件。", 409)
    return json.loads(path.read_text(encoding="utf-8"))


def _json_path(path: str | Path) -> str:
    # Win32 metadata APIs still apply MAX_PATH on some native installations.
    # This is lexical spelling only; never resolve a link to a different object.
    value = os.path.abspath(path)
    if sys.platform != 'win32' or value.startswith('\\\\?\\'):
        return value
    return '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value


def _replace_json(temporary: str, path: Path) -> None:
    # Windows readers/scanners can briefly deny an atomic replacement. Retry
    # only these native errors, using the same already-flushed temporary file.
    # Never unlink the destination or fall back to an in-place write. Persistent
    # permission errors still propagate, and every attempt rechecks the link rule.
    deadline = time.monotonic() + 0.5
    while True:
        if Path(_json_path(path)).is_symlink():
            raise ProjectError("不能覆盖符号链接项目文件。", 409)
        try:
            os.replace(_json_path(temporary), _json_path(path))
            return
        except OSError as error:
            remaining = deadline - time.monotonic()
            if os.name != 'nt' or getattr(error, 'winerror', None) not in {5, 32, 33} or remaining <= 0:
                raise
            time.sleep(min(0.01, remaining))


def write_json(path: Path, value) -> None:
    if Path(_json_path(path)).is_symlink():
        raise ProjectError("不能覆盖符号链接项目文件。", 409)
    fd, temporary = tempfile.mkstemp(prefix=".opendirector-", suffix=".tmp", dir=_json_path(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        _replace_json(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class LocalProjects:
    """Coordination only; never reads, migrates or repairs old project data."""
    LEASE_SECONDS = 60

    def __init__(self, repository: Path):
        self.repository = repository.resolve()
        self.root = self.repository / "projects"
        self.state_dir = self.repository / ".opendirector"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.lock = FileLock(self.state_dir / "catalog.lock", timeout=15)
        self.database = self.state_dir / "catalog.sqlite3"
        with self.transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, expires REAL NOT NULL,
                    path TEXT NOT NULL DEFAULT ''
                );
            """)
            db.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))


    @contextmanager
    def transaction(self):
        with self.lock:
            db = sqlite3.connect(self.database, timeout=15)
            db.row_factory = sqlite3.Row
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.close()


    def _check_root(self):
        if self.root.is_symlink() or self.root.resolve() != self.root:
            raise ProjectError("projects 不能是符号链接，请使用仓库内的项目文件夹。", 409)
        if self.root.exists() and not self.root.is_dir():
            raise ProjectError("仓库下的 projects 不是文件夹，请检查后重试。", 409)


    @staticmethod
    def _conflict(parent: Path, name: str, source: Path | None = None):
        for entry in parent.iterdir():
            if entry.name.casefold() == name.casefold() and entry != source:
                raise ProjectError("该位置已有同名文件或文件夹，请使用其他名称。", 409)


    def _open(self, db, project: dict, session: str):
        identifier(session)
        project_id = project["id"]
        if db.execute("SELECT 1 FROM sessions WHERE project_id=? AND id<>? AND expires>?", (project_id, session, time.time())).fetchone():
            raise ProjectError("该项目正在其他窗口中打开，请先关闭后再试。", 409, code="project_open_elsewhere")
        lease = db.execute("SELECT path FROM sessions WHERE id=? AND project_id=? AND expires>?", (session, project_id, time.time())).fetchone()
        if lease and lease["path"] != project["path"]:
            raise ProjectError("项目目录已在应用外改名或移动，请复制未保存内容并刷新页面。", 409)
        db.execute("INSERT INTO sessions(id,project_id,expires,path) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,expires=excluded.expires,path=excluded.path", (session, project_id, time.time() + self.LEASE_SECONDS, project["path"]))


    def release(self, session: str):
        with self.transaction() as db:
            db.execute("DELETE FROM sessions WHERE id=?", (session,))
