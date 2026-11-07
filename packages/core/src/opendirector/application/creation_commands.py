"""Route a creation command to the service that owns that intent.

Project storage commits the result. Choosing the service stays here so
infrastructure does not import application modules.
"""
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import CreationCanvas
from opendirector.application.creation_history import CreationHistory
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.projects import ProjectError, project_name
from opendirector.ports.dispatch import register_command_dispatcher

_ASSET_COMMANDS = {'asset.import', 'asset.writeText', 'asset.updateMetadata'}
_HISTORY_COMMANDS = {
    'history.undo', 'history.redo', 'generationSpec.restore', 'canvas.applyVersion', 'asset.delete',
}


class CreationCommands:
    def execute(self, projects, command, *, session=None, source='ui', imported_from=None):
        if command.type == 'project.trash':
            return projects._trash(command, source)
        if command.type == 'project.restore':
            raise ProjectError('回收目录中的工程暂不支持在应用内恢复。', 501, code='capability_unsupported')
        if command.type in _ASSET_COMMANDS:
            return CreationAssets(projects).execute(
                command, session=session, source=source, imported_from=imported_from)
        if imported_from is not None:
            raise ProjectError('只有素材导入可以声明归档来源。', 400, code='invalid_input')
        if command.type == 'project.create':
            return projects._create(command, source)
        if command.type in _HISTORY_COMMANDS:
            return CreationHistory(projects).execute(command, session=session, source=source)
        if command.type != 'project.rename':
            return CreationCanvas(projects).execute(command, session=session, source=source)

        def rename(snapshot):
            name = project_name(command.payload.name)
            if snapshot.project.name == name:
                return snapshot
            data = snapshot.model_dump()
            data['project'] = dict(id=snapshot.project.id, name=name, revision=snapshot.project.revision + 1)
            return ProjectSnapshot.model_validate(data)

        return projects.commit(command, rename, session=session, source=source)


def register_creation_commands() -> None:
    register_command_dispatcher(CreationCommands())
