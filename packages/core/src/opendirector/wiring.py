"""Composition root that binds infrastructure adapters to application ports.

Application and infrastructure must not import this module. Process
entrypoints call ``configure_runtime`` before executing commands or opening
storage-backed services.
"""
from pathlib import Path

from opendirector.application.creation_commands import register_creation_commands
from opendirector.infrastructure.app_settings import AppSettings
from opendirector.infrastructure.creation_files import file_identity as read_file_identity
from opendirector.infrastructure.directories import directory as ensure_directory, sync_directory
from opendirector.infrastructure.execution_files import execution_file
from opendirector.infrastructure.timeline_package_imports import TimelinePackageImports
from opendirector.infrastructure.creation_uploads import (
    CreationUploads, asset_name as normalize_asset_name, inspect_file as inspect_media_file,
    upload_asset_id as stable_upload_asset_id,
)
from opendirector.infrastructure.generation_results import GenerationResults
from opendirector.infrastructure.library_store import LibraryStore
from opendirector.infrastructure.library_store import media_kind as library_media_kind
from opendirector.infrastructure.library_store import now as library_timestamp
from opendirector.infrastructure.local_projects import child as child_path
from opendirector.infrastructure.local_projects import read_json as read_json_file
from opendirector.infrastructure.local_projects import write_json as write_json_file
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.ports.gateway import register_gateway


class InfrastructureGateway:
    """Concrete adapters behind ``opendirector.ports.gateway``."""

    def child(self, directory: Path, name: str) -> Path:
        return child_path(directory, name)

    def read_json(self, path: Path):
        return read_json_file(path)

    def write_json(self, path: Path, value) -> None:
        write_json_file(path, value)

    def directory(self, path: Path) -> Path:
        return ensure_directory(path)

    def file_identity(self, path: Path):
        return read_file_identity(path)

    def execution_file(self, directory: Path, path: str, *, create=False):
        return execution_file(directory, path, create=create)

    def sync_directory(self, path: Path) -> None:
        sync_directory(path)

    def timeline_package_imports(self, projects):
        return TimelinePackageImports(projects)

    def asset_name(self, value: str) -> str:
        return normalize_asset_name(value)

    def upload_asset_id(self, project_id, handle):
        return stable_upload_asset_id(project_id, handle)

    def inspect_file(self, path: Path, name: str, *, expected_kind=None):
        return inspect_media_file(path, name, expected_kind=expected_kind)

    def uploads(self, projects):
        return CreationUploads(projects)

    def models(self, repository: Path):
        return ModelConfigs(repository)

    def settings(self, repository: Path):
        return AppSettings(repository)

    def results(self, directory, task_id):
        return GenerationResults(directory, task_id)

    def library(self, state_dir: Path):
        return LibraryStore(state_dir)

    def media_kind(self, mime: str, name: str = ''):
        return library_media_kind(mime, name)

    def library_now(self) -> str:
        return library_timestamp()


def configure_runtime() -> InfrastructureGateway:
    """Bind ports and command dispatch. Safe to call more than once."""
    ports = InfrastructureGateway()
    register_gateway(ports)
    register_creation_commands()
    return ports
