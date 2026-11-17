"""Small durable orchestration journal; project facts remain in CreationProjects."""
from uuid import UUID
from filelock import FileLock
from opendirector.domain.projects import ProjectError
from opendirector.domain.timeline_errors import timeline_error, timeline_error_message
from opendirector.domain.creation.timeline_packages import TimelinePackageImportReceipt
from opendirector.infrastructure.creation_projects import directory, durable_json
from opendirector.infrastructure.local_projects import child, read_json


class TimelinePackageImports:
    def __init__(self, projects):
        self.projects = projects

    def folder(self, project_id, operation_id):
        root = directory(child(directory(self.projects.state_dir), 'timeline-package-imports'))
        root.mkdir(mode=0o700, exist_ok=True)
        target = directory(child(root, str(UUID(str(project_id)))))
        target.mkdir(mode=0o700, exist_ok=True)
        folder = directory(child(target, str(UUID(str(operation_id)))))
        folder.mkdir(mode=0o700, exist_ok=True)
        return folder

    def lock(self, project_id, operation_id):
        return FileLock(child(self.folder(project_id, operation_id), 'operation.lock'), timeout=0, thread_local=False)

    def read(self, project_id, operation_id):
        self.projects.snapshot(project_id)
        path = child(self.folder(project_id, operation_id), 'record.json')
        try:
            return read_json(path)
        except FileNotFoundError:
            return None

    def write(self, project_id, request, receipt):
        durable_json(child(self.folder(project_id, request.operationId), 'record.json'),
                     dict(request=request.model_dump(mode='json'), receipt=receipt.model_dump(mode='json')))

    def receipt(self, project_id, operation_id):
        record = self.read(project_id, operation_id)
        if record is None:
            raise timeline_error('timeline_import_missing', 404)
        return TimelinePackageImportReceipt.model_validate(record['receipt'])
