"""Install optional, portable Skill packages without executing their contents."""
from contextlib import contextmanager
import errno
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import stat
import time
from tempfile import TemporaryDirectory, mkdtemp
from typing import get_args
from unicodedata import normalize
from zipfile import BadZipFile, ZipFile
from zlib import error as CompressionError

from filelock import FileLock
import httpx
from pydantic import ValidationError
import yaml

from opendirector.agent.context import RuntimeId
from opendirector.domain.plugins import PLUGIN_ERRORS, InstalledPlugin, PluginManifest, PluginRegistryRecord
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.execution_files import execution_file
from opendirector.infrastructure.local_projects import read_json, write_json
from opendirector.installation import plugin_catalog, plugin_examples
from opendirector.integrations.http_settings import public_target_sync

MANIFEST = 'opendirector-plugin.json'
MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
MAX_PACKAGE_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_FILES = 256


def failure(code, status=400):
    return ProjectError(PLUGIN_ERRORS[code][0], status, code=code)


def safe_path(name):
    path = PurePosixPath(name)
    if (not name or any(character in '\\:*?"<>|' or ord(character) < 32 for character in name) or path.is_absolute()
            or name != path.as_posix() or any(part in {'.', '..'} or part.endswith((' ', '.'))
            or PureWindowsPath(part).is_reserved() for part in path.parts)):
        raise failure('plugin_unsafe_path')
    return path


def is_alias(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def read_package_file(path, limit):
    try:
        with execution_file(path.parent, path.name, allow_empty=True) as stream:
            return stream.read(limit + 1)
    except ProjectError:
        raise failure('plugin_unsafe_path') from None
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR} or getattr(error, 'winerror', None) == 1920:
            raise failure('plugin_unsafe_path') from None
        raise


def package_files(source):
    files = {}
    names = set()
    paths = {}
    total = 0

    def unreadable(error):
        raise error

    def add(name, content):
        nonlocal total
        path = safe_path(name)
        name = normalize('NFC', name)
        for part in (path, *path.parents):
            canonical = normalize('NFC', part.as_posix())
            key = canonical.casefold()
            if key in paths and paths[key] != canonical:
                raise failure('plugin_invalid')
            paths[key] = canonical
        key = name.casefold()
        if key in names:
            raise failure('plugin_invalid')
        names.add(key)
        total += len(content)
        if len(names) > MAX_FILES or len(content) > MAX_FILE_BYTES or total > MAX_PACKAGE_BYTES:
            raise failure('plugin_too_large', 413)
        files[name] = content

    if isinstance(source, Path):
        if is_alias(source):
            raise failure('plugin_unsafe_path')
        # Keep the checked pathname; resolving it could follow a replacement link.
        source = Path(os.path.abspath(source))
    if isinstance(source, Path) and source.is_dir():
        for parent, directories, entries in os.walk(source, followlinks=False, onerror=unreadable):
            for name in directories + entries:
                path = Path(parent) / name
                if is_alias(path):
                    raise failure('plugin_unsafe_path')
                safe_path(path.relative_to(source).as_posix())
                if path.is_dir():
                    continue
                if not stat.S_ISREG(path.stat().st_mode):
                    raise failure('plugin_unsafe_path')
                add(path.relative_to(source).as_posix(), read_package_file(path, MAX_FILE_BYTES))
    else:
        if isinstance(source, Path):
            if not stat.S_ISREG(source.stat().st_mode):
                raise failure('plugin_unsafe_path')
            source = read_package_file(source, MAX_ARCHIVE_BYTES)
        if len(source) > MAX_ARCHIVE_BYTES:
            raise failure('plugin_too_large', 413)
        try:
            with ZipFile(BytesIO(source)) as archive:
                if len(archive.infolist()) > MAX_FILES:
                    raise failure('plugin_too_large', 413)
                for item in archive.infolist():
                    safe_path(item.filename.rstrip('/'))
                    mode = stat.S_IFMT(item.external_attr >> 16)
                    if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or item.flag_bits & 1:
                        raise failure('plugin_unsafe_path')
                    if item.is_dir():
                        continue
                    if item.file_size > MAX_FILE_BYTES:
                        raise failure('plugin_too_large', 413)
                    with archive.open(item) as stream:
                        add(item.filename, stream.read(MAX_FILE_BYTES + 1))
        except (BadZipFile, RuntimeError, ValueError, EOFError, NotImplementedError, CompressionError):
            raise failure('plugin_invalid') from None
    try:
        if any(parent.as_posix().casefold() in names for name in files for parent in PurePosixPath(name).parents):
            raise ValueError()
        if len(files[MANIFEST]) > 65536:
            raise ValueError()
        value = json.loads(files[MANIFEST])
        if not isinstance(value, dict) or type(value.get('schemaVersion')) is not int:
            raise ValueError()
        manifest = PluginManifest.model_validate(value)
        if (set(manifest.runtimes) - set(get_args(RuntimeId)) or len(set(manifest.runtimes)) != len(manifest.runtimes)
                or manifest.id in manifest.dependencies):
            raise ValueError()
        raw = files[f'skills/{manifest.id}/SKILL.md']
        entry = raw.decode('utf-8').replace('\r\n', '\n')
        if len(raw) > 65536 or not entry.startswith('---\n') or '\n---\n' not in entry[3:]:
            raise ValueError()
        # Validate the package identity only; native harnesses still discover and load the skill.
        metadata = yaml.safe_load(entry[4:].split('\n---\n', 1)[0])
        if (not isinstance(metadata, dict) or metadata.get('name') != manifest.id
                or not isinstance(metadata.get('description'), str) or not metadata['description'].strip()):
            raise ValueError()
        allowed = f'skills/{manifest.id}/'
        if any(name.startswith('skills/') and not name.startswith(allowed) for name in files):
            raise ValueError()
        if any(PurePosixPath(name).name.casefold() == 'skill.md' and name != allowed + 'SKILL.md' for name in files):
            raise ValueError()
    except (KeyError, ValueError, TypeError, UnicodeError, yaml.YAMLError, ValidationError):
        raise failure('plugin_invalid') from None
    digest = sha256()
    for name, content in sorted(files.items()):
        digest.update(name.encode() + b'\0' + str(len(content)).encode() + b'\0' + content)
    return manifest, files, digest.hexdigest()


def download_package(url):
    deadline = time.monotonic() + 60
    try:
        current = httpx.URL(url)
        with httpx.Client(trust_env=False, timeout=20, follow_redirects=False) as client:
            for _ in range(6):
                pinned, headers, extensions = public_target_sync(current, schemes=('https',),
                    unsafe=lambda: failure('plugin_url_unsafe'), unresolved=lambda: failure('plugin_source_unavailable'))
                headers['Accept-Encoding'] = 'identity'
                if time.monotonic() > deadline:
                    raise failure('plugin_source_unavailable')
                with client.stream('GET', pinned, headers=headers, extensions=extensions) as response:
                    if response.is_redirect:
                        if not response.headers.get('location'):
                            break
                        current = current.join(response.headers['location'])
                        continue
                    response.raise_for_status()
                    content = bytearray()
                    for chunk in response.iter_raw(65536):
                        if time.monotonic() > deadline:
                            raise failure('plugin_source_unavailable')
                        content.extend(chunk)
                        if len(content) > MAX_ARCHIVE_BYTES:
                            raise failure('plugin_too_large', 413)
                    return bytes(content)
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        raise failure('plugin_source_unavailable') from None
    raise failure('plugin_source_unavailable')


class PluginRegistry:
    def __init__(self, repository):
        self.repository = Path(repository).resolve()
        self.directory = self.repository / '.opendirector' / 'plugins'
        self.path = self.directory / 'registry.json'

    @contextmanager
    def locked(self):
        for path in (self.directory.parent, self.directory, self.directory / 'packages'):
            if path.is_symlink() or path.exists() and (is_alias(path) or not path.is_dir()):
                raise failure('plugin_unsafe_path', 409)
            path.mkdir(parents=True, exist_ok=True)
        lock = self.directory / 'registry.lock'
        if lock.is_symlink():
            raise failure('plugin_unsafe_path', 409)
        with FileLock(lock, timeout=15):
            yield

    def read(self):
        if not self.path.exists() and not self.path.is_symlink():
            return PluginRegistryRecord()
        try:
            value = read_json(self.path)
            if not isinstance(value, dict) or set(value) != {'version', 'plugins'} or type(value['version']) is not int:
                raise ValueError()
            state = PluginRegistryRecord.model_validate(value)
            for key, item in state.plugins.items():
                if (key != item.manifest.id or set(item.manifest.runtimes) - set(get_args(RuntimeId))
                        or set(item.enabledRuntimes) - set(item.manifest.runtimes)):
                    raise ValueError()
            return state
        except (ValueError, TypeError, ProjectError):
            raise failure('plugin_registry_invalid', 409) from None

    def save(self, state):
        write_json(self.path, state.model_dump(by_alias=True))

    def verify(self, item):
        try:
            digest = package_files(self.directory / 'packages' / item.digest)[2]
        except OSError:
            raise failure('plugin_invalid', 409) from None
        if digest != item.digest:
            raise failure('plugin_invalid', 409)

    def catalog(self):
        with self.locked():
            installed = [item.model_dump(by_alias=True) for item in self.read().plugins.values()]
        examples = []
        if plugin_catalog().is_file():
            for item in read_json(plugin_catalog()):
                manifest = PluginManifest.model_validate(item['manifest'])
                examples.append({**item, 'manifest': manifest.model_dump(by_alias=True), 'source': f'example:{manifest.id}'})
        return {'installed': installed, 'examples': examples, 'runtimes': list(get_args(RuntimeId))}

    def install(self, source):
        label = 'upload'
        expected_digest = None
        try:
            if isinstance(source, str):
                label = source
                if source.startswith('example:'):
                    example = next((item for item in self.catalog()['examples'] if item['source'] == source), None)
                    if example is None:
                        raise failure('plugin_source_unavailable', 404)
                    expected_digest = example['digest']
                    path = plugin_examples() / example['manifest']['id']
                    source = path if path.is_dir() else download_package(example['url'])
                elif '://' in source:
                    source = download_package(source)
                    label = str(httpx.URL(label).copy_with(query=None, fragment=None))
                else:
                    windows = PureWindowsPath(source)
                    if any(ord(character) < 32 for character in source) or windows.drive and not windows.root:
                        raise failure('plugin_unsafe_path')
                    requested = os.path.abspath(os.path.join(self.repository, source))
                    # Resolve parent aliases before authorizing reads; keep the entry itself for link rejection.
                    parent = os.path.realpath(os.path.dirname(requested))
                    candidate = os.path.normpath(os.path.join(parent, os.path.basename(requested)))
                    root = os.fspath(self.repository)
                    if candidate.startswith(os.path.join(root, '')):
                        source = Path(candidate)
                    else:
                        raise failure('plugin_source_outside_workspace', 403)
                    if (source == self.repository
                            or source.relative_to(self.repository).parts[0].casefold() in {'projects', '.opendirector'}):
                        raise failure('plugin_source_outside_workspace', 403)
            manifest, files, digest = package_files(source)
            if expected_digest is not None and digest != expected_digest:
                raise failure('plugin_invalid')
        except OSError:
            raise failure('plugin_source_unavailable') from None
        with self.locked():
            state = self.read()
            previous = state.plugins.get(manifest.id)
            if previous:
                if previous.digest != digest:
                    raise failure('plugin_conflict', 409)
                return previous.model_dump(by_alias=True)
            destination = self.directory / 'packages' / digest
            reusable = False
            if destination.exists() or destination.is_symlink():
                try:
                    reusable = package_files(destination)[2] == digest
                except (ProjectError, OSError):
                    pass
            if not reusable:
                with TemporaryDirectory(prefix='.install-', dir=self.directory) as temporary:
                    staging = Path(temporary) / 'package'
                    staging.mkdir()
                    for name, content in files.items():
                        path = staging / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(content)
                    if destination.exists() or destination.is_symlink():
                        # Preserve a damaged cache for diagnosis; never delete its uncertain contents.
                        preserved = Path(mkdtemp(prefix='.damaged-', dir=self.directory)) / 'package'
                        os.replace(destination, preserved)
                    os.replace(staging, destination)
            record = InstalledPlugin(manifest=manifest, digest=digest, source=label)
            state.plugins[manifest.id] = record
            self.save(state)
            return record.model_dump(by_alias=True)

    def change(self, plugin_id, digest, *, runtime=None, enabled=None):
        with self.locked():
            state = self.read()
            item = state.plugins.get(plugin_id)
            if item is None:
                raise failure('plugin_missing', 404)
            if item.digest != digest:
                raise failure('plugin_changed', 409)
            if runtime is not None and runtime not in item.manifest.runtimes:
                raise failure('plugin_runtime_unsupported', 409)
            if enabled:
                self.verify(item)
                for dependency, version in item.manifest.dependencies.items():
                    other = state.plugins.get(dependency)
                    if other is None or other.manifest.version != version or runtime not in other.enabledRuntimes:
                        raise failure('plugin_dependency_missing', 409)
            else:
                for other in state.plugins.values():
                    if plugin_id in other.manifest.dependencies and (runtime in other.enabledRuntimes
                            if runtime is not None else other.enabledRuntimes):
                        raise failure('plugin_required', 409)
            if runtime is None:
                # Retain immutable package files: already accepted turns may still be taking their snapshot.
                del state.plugins[plugin_id]
            else:
                item.enabledRuntimes = [value for value in item.enabledRuntimes if value != runtime]
                if enabled:
                    item.enabledRuntimes.append(runtime)
            self.save(state)
        return self.catalog()

    def skills(self, runtime):
        with self.locked():
            items = list(self.read().plugins.values())
        result = []
        for item in items:
            if runtime not in item.enabledRuntimes:
                continue
            path = self.directory / 'packages' / item.digest
            self.verify(item)
            result.append({'name': item.manifest.id, 'pluginId': item.manifest.id, 'pluginDigest': item.digest,
                'filePath': str(path / 'skills' / item.manifest.id / 'SKILL.md'),
                'displayName': item.manifest.name.model_dump(by_alias=True),
                'localizedDescription': item.manifest.description.model_dump(by_alias=True)})
        return result
