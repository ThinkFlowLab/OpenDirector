"""Discover approved skills with OpenCode's native loader."""
import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from opendirector.agent.native import BUNDLED_INSTALL_ERROR, executable
from opendirector.agent.process import terminate
from opendirector.agent.plugins import PluginRegistry, failure
from opendirector.installation import builtin_skills
from opendirector.domain.projects import ProjectError


async def native_catalog(roots: list[Path]) -> list[dict]:
    binary = executable('default')
    if binary is None:
        raise ProjectError(BUNDLED_INSTALL_ERROR, 503, code='agent_dependency_unavailable')
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
                return json.loads(data)
            except json.JSONDecodeError:
                raise ProjectError("OpenCode 返回了无效的技能目录，请检查 CLI 版本。", 503) from None
        finally:
            await terminate(process)


async def skills(repository: Path, directory: Path, runtime: str = 'default') -> list[dict]:
    roots = [path.resolve() for path in [directory / '.opendirector/skills',
        repository / '.opendirector/skills', builtin_skills()] if path.is_dir()]
    plugins = await asyncio.to_thread(PluginRegistry(repository).skills, runtime)
    catalog = await native_catalog(roots)
    entries = {Path(item['filePath']).resolve(): item for item in plugins}
    if plugins:
        # Native discovery deduplicates names; keep plugins from silently replacing ordinary skills.
        if {item['name'] for item in plugins} & {item['name'] for item in catalog}:
            raise failure('plugin_skill_conflict', 409)
        plugin_roots = [path.parent.parent for path in entries]
        # Native virtual skills have no file to expose or copy into the project.
        discovered = [item for item in await native_catalog(plugin_roots) if Path(item['location']).is_absolute()]
        if (len(discovered) != len(entries)
                or {Path(item['location']).resolve() for item in discovered} != set(entries)):
            raise failure('plugin_skill_conflict', 409)
        catalog += discovered
        roots += plugin_roots
    found = []
    for item in catalog:
        path = Path(item['location']).resolve()
        if any(path.is_relative_to(root) for root in roots) and path.is_file() and path.stat().st_size <= 65536:
            plugin = entries.get(path)
            if plugin and plugin['name'] != item['name']:
                raise failure('plugin_skill_conflict', 409)
            source = 'plugin' if plugin else 'builtin' if path.is_relative_to(builtin_skills()) else 'project' if path.is_relative_to(directory / '.opendirector/skills') else 'workspace'
            found.append({'name': item['name'], 'description': item['description'], 'filePath': str(path), 'source': source,
                          **(plugin or {})})
    if (set(entries) != {Path(item['filePath']).resolve() for item in found if item['source'] == 'plugin'}
            or len({item['name'] for item in found}) != len(found)):
        raise failure('plugin_skill_conflict', 409)
    return found
