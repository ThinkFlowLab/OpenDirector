"""Discover approved skills with OpenCode's native loader."""
import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from opendirector.agent.native import BUNDLED_INSTALL_ERROR, executable
from opendirector.agent.process import terminate
from opendirector.installation import builtin_skill_roots
from opendirector.domain.projects import ProjectError


async def skills(repository: Path, directory: Path) -> list[dict[str, str]]:
    binary = executable('default')
    if binary is None:
        raise ProjectError(BUNDLED_INSTALL_ERROR, 503, code='agent_dependency_unavailable')
    builtin_roots = [path.resolve() for path in builtin_skill_roots() if path.is_dir()]
    project_root = (directory / '.opendirector/skills').resolve()
    workspace_root = (repository / '.opendirector/skills').resolve()
    roots = [path for path in (project_root, workspace_root, *builtin_roots) if path.is_dir()]
    with TemporaryDirectory(prefix='od-skills-') as temporary:
        env = {**os.environ, 'XDG_CONFIG_HOME': temporary,
               'OPENCODE_DISABLE_EXTERNAL_SKILLS': '1', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS': '1',
               'OPENCODE_CONFIG_CONTENT': json.dumps({'skills': {'paths': list(map(str, roots))}})}
        try:
            process = await asyncio.create_subprocess_exec(binary, 'debug', 'skill', '--pure',
                cwd=temporary, env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except OSError as error:
            raise ProjectError(BUNDLED_INSTALL_ERROR, 503, code='agent_dependency_unavailable') from error
        try:
            data, _ = await asyncio.wait_for(process.communicate(), 20)
            if process.returncode:
                raise ProjectError(BUNDLED_INSTALL_ERROR, 503, code='agent_dependency_unavailable')
            try:
                catalog = json.loads(data)
            except json.JSONDecodeError:
                raise ProjectError("OpenCode 返回了无效的技能目录，请检查 CLI 版本。", 503) from None
            found = []
            for item in catalog:
                path = Path(item['location']).resolve()
                if any(path.is_relative_to(root) for root in roots) and path.is_file() and path.stat().st_size <= 65536:
                    if any(path.is_relative_to(root) for root in builtin_roots):
                        source = 'builtin'
                    else:
                        source = 'project' if path.is_relative_to(project_root) else 'workspace'
                    found.append({'name': item['name'], 'description': item['description'], 'filePath': str(path), 'source': source})
            return found
        finally:
            await terminate(process)
