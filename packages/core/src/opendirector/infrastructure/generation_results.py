"""Private recovery cache. Locators never appear in public task receipts."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

from opendirector.domain.assets import MAX_ASSET_BYTES
from opendirector.domain.projects import ProjectError, identifier
from opendirector.infrastructure.local_projects import child, read_json, write_json


def _submission_digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


class GenerationResults:
    def __init__(self, directory, task_id):
        self.root = child(Path(directory), '.generation-results')
        self.directory = child(self.root, identifier(task_id))

    def _prepare(self):
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.directory.mkdir(mode=0o700, exist_ok=True)
        if os.name == 'posix':
            self.root.chmod(0o700)
            self.directory.chmod(0o700)

    def metadata(self):
        path = child(self.directory, 'result.json')
        if not path.exists():
            return None
        try:
            value = read_json(path)
            if value['suffix'] not in {'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mp3', 'wav', 'md', 'txt'}:
                raise ValueError()
            if value.get('url'):
                parts = urlsplit(value['url'])
                if parts.scheme not in {'http', 'https'} or not parts.hostname or parts.username or parts.password:
                    raise ValueError()
            return value
        except (KeyError, ValueError, TypeError):
            raise ProjectError('生成恢复缓存无效，请保留原文件并核对任务。', 409) from None

    def locator(self, suffix, url):
        self._prepare()
        parts = urlsplit(url)
        if parts.scheme not in {'http', 'https'} or not parts.hostname or parts.username or parts.password or len(url) > 16384:
            raise ProjectError('生成结果地址无效，未重新提交生成。', 409)
        write_json(child(self.directory, 'result.json'), {'suffix': suffix, 'url': url})

    def submission(self):
        """Exact idempotent request and provider locators; never public receipts."""
        path = child(self.directory, 'submission.json')
        if not path.exists():
            return None
        try:
            record = read_json(path)
            value = record['submission']
            if not isinstance(value, dict) or record['sha256'] != _submission_digest(value):
                raise ValueError()
            return value
        except (KeyError, ValueError, TypeError):
            raise ProjectError('生成恢复缓存无效，请保留原文件并核对任务。', 409) from None

    def save_submission(self, value):
        self._prepare()
        write_json(child(self.directory, 'submission.json'), {'submission': value, 'sha256': _submission_digest(value)})

    def data(self):
        metadata = self.metadata()
        path = child(self.directory, 'output')
        if not metadata or not path.exists():
            return None
        if path.stat().st_size > MAX_ASSET_BYTES:
            raise ProjectError('生成恢复缓存超过大小限制。', 409)
        return metadata['suffix'], path.read_bytes()

    def save(self, suffix, data):
        if len(data) > MAX_ASSET_BYTES:
            raise ProjectError('生成结果超过 50 MB，无法保存到项目。', 413)
        self._prepare()
        # Metadata precedes the atomic complete-file replacement. A crash can
        # leave a locator or no output, but never a partial file named output.
        metadata = self.metadata()
        if metadata and metadata['suffix'] != suffix:
            raise ProjectError('生成结果格式与恢复记录不一致。', 409)
        if not metadata:
            write_json(child(self.directory, 'result.json'), {'suffix': suffix})
        fd, temporary = tempfile.mkstemp(prefix='.output-', dir=self.directory)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, child(self.directory, 'output'))
            write_json(child(self.directory, 'result.json'), {'suffix': suffix})
        finally:
            Path(temporary).unlink(missing_ok=True)

    def clear(self):
        # Remove only this task's cache after the durable success receipt.
        for name in ('output', 'result.json', 'submission.json'):
            child(self.directory, name).unlink(missing_ok=True)
        for directory in (self.directory, self.root):
            try:
                directory.rmdir()
            except OSError:
                pass  # Other tasks or incomplete temporary files may remain.
