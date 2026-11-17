"""Ports application services use instead of concrete infrastructure."""
from pathlib import Path
from typing import Protocol

from opendirector.ports.dispatch import PortsNotConfigured


class InfrastructurePorts(Protocol):
    """Storage and media operations the application layer is allowed to request."""

    def child(self, directory: Path, name: str) -> Path:
        """Return a managed path and reject a symlink at the final segment."""

    def read_json(self, path: Path):
        """Read one JSON document."""

    def write_json(self, path: Path, value) -> None:
        """Atomically replace one JSON document."""

    def directory(self, path: Path) -> Path:
        """Return a real directory path, rejecting symlinks and non-directories."""

    def file_identity(self, path: Path):
        """Return the fingerprint and size of a regular file."""

    def execution_file(self, directory: Path, path: str, *, create=False):
        """Open a scoped execution file through the platform's guarded adapter."""

    def sync_directory(self, path: Path) -> None:
        """Persist a directory entry where the platform supports it."""

    def timeline_package_imports(self, projects):
        """Recoverable import journal bound to one project repository."""

    def asset_name(self, value: str) -> str:
        """Normalize a user-supplied asset name."""

    def upload_asset_id(self, project_id, handle):
        """Stable asset id for one staged upload."""

    def inspect_file(self, path: Path, name: str, *, expected_kind=None):
        """Probe a file and return its media kind and metadata."""

    def uploads(self, projects):
        """Staging session bound to one project repository."""

    def models(self, repository: Path):
        """Model configuration store for one data directory."""

    def settings(self, repository: Path):
        """Application preference store for one data directory."""

    def results(self, directory, task_id):
        """Private generation-result cache for one task."""

    def library(self, state_dir: Path):
        """Global library index and blob store."""

    def media_kind(self, mime: str, name: str = ''):
        """Library media kind for a MIME type and file name."""

    def library_now(self) -> str:
        """UTC timestamp used by library mutations."""


_ports: InfrastructurePorts | None = None


def register_gateway(ports: InfrastructurePorts) -> None:
    global _ports
    _ports = ports


def gateway() -> InfrastructurePorts:
    if _ports is None:
        raise PortsNotConfigured(
            'Infrastructure ports are not configured. Call opendirector.wiring.configure_runtime().')
    return _ports
