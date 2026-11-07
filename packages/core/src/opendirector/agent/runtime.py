"""Runtime catalog and shared per-turn execution boundary."""
import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import asdict, dataclass, replace
from typing import Literal

from opendirector.agent.context import AgentEvent, RunContext, RuntimeId
from opendirector.agent.gateway import ToolGateway
import opendirector.agent.native as native
import opendirector.agent.jiuwenswarm as jiuwenswarm
from opendirector.agent.tools import AgentTools
from opendirector.agent.process import terminate
from opendirector.domain.projects import ProjectError


@dataclass(frozen=True, kw_only=True)
class RuntimeSpec:
    id: RuntimeId
    label: str
    group: Literal['default', 'harness']
    modelSource: Literal['settings', 'cli']
    modelOverride: bool
    engine: RuntimeId
    supportsSkills: bool = True


RUNTIMES = {
    'default': RuntimeSpec(id='default', label='Default', group='default', modelSource='settings', modelOverride=False, engine='default'),
    'opencode': RuntimeSpec(id='opencode', label='OpenCode', group='harness', modelSource='cli', modelOverride=True, engine='opencode'),
    'jiuwenswarm': RuntimeSpec(id='jiuwenswarm', label='JiuwenSwarm', group='harness', modelSource='cli', modelOverride=True, engine='jiuwenswarm'),
    'deepseek': RuntimeSpec(id='deepseek', label='DeepSeek Harness', group='harness', modelSource='cli', modelOverride=True, engine='deepseek'),
    'codex': RuntimeSpec(id='codex', label='Codex', group='harness', modelSource='cli', modelOverride=True, engine='codex'),
    'claude': RuntimeSpec(id='claude', label='Claude Code', group='harness', modelSource='cli', modelOverride=True, engine='claude'),
}


def runtime_spec(name: str) -> RuntimeSpec:
    try:
        return RUNTIMES[name]
    except KeyError:
        raise ProjectError('未知 Agent 引擎。') from None


def installation(name: str) -> str | None:
    """The executable serving a runtime, or None when it is not installed.

    Every engine answers through this one seam. Before this, jiuwenswarm was the
    only harness with its own probe, so a caller or a test could patch one seam
    and still get the other one's answer.
    """
    spec = runtime_spec(name)
    if spec.engine == 'jiuwenswarm':
        return jiuwenswarm.executable()
    return native.executable(spec.engine)


def runtime_available(name: str) -> bool:
    return installation(name) is not None


async def runtime_status(name: str, *, probe: bool = True) -> str:
    """One runtime's state. `probe` false reports the cheap catalog state only."""
    if not probe:
        if installation(name) is None:
            return 'not_installed'
        return 'ready' if runtime_spec(name).engine == 'opencode' else 'checking'
    return await runtime_readiness(name)


def runtime_catalog() -> list[dict]:
    return [{**asdict(spec), 'available': runtime_available(spec.id)}
            for spec in RUNTIMES.values()]


async def runtime_readiness(engine: str) -> str:
    """Probe one engine. Installation is decided once, by `installation`."""
    executable = installation(engine)
    if executable is None:
        return 'not_installed'
    if engine == 'deepseek':
        from opendirector.agent.deepseek import model_choices
        try:
            return 'ready' if await model_choices() else 'needs_configuration'
        except ProjectError:
            return 'unknown'
    if engine == 'jiuwenswarm':
        return await jiuwenswarm.readiness(executable)
    if engine == 'opencode':
        return 'ready'
    args = ['--version'] if engine == 'default' else ['login', 'status'] if engine == 'codex' else ['auth', 'status', '--json']
    try:
        process = await asyncio.create_subprocess_exec(
            str(executable), *args, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return 'unknown'
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 5)
        if engine == 'default':
            return 'ready' if process.returncode == 0 and output.strip() else 'unknown'
        if engine == 'claude':
            try:
                logged_in = json.loads(output)['loggedIn']
            except (ValueError, KeyError, TypeError):
                return 'unknown'
            return 'ready' if logged_in is True else 'needs_login'
        return 'ready' if process.returncode == 0 else 'needs_login'
    except TimeoutError:
        return 'unknown'
    finally:
        await terminate(process, group=True)


async def configured_runtimes() -> list[dict]:
    engines = tuple(RUNTIMES)
    states = dict(zip(engines, await asyncio.gather(*(runtime_readiness(engine) for engine in engines))))
    return [{**item, 'status': states[item['engine']]} for item in runtime_catalog()]


class AgentRuntimes:
    def __init__(self, projects, generation, configs, provider=None):
        self.business = AgentTools(projects, generation, configs)
        self.adapter = native.NativeRuntime(provider)
        self.jiuwenswarm = jiuwenswarm.JiuwenSwarmRuntime()

    async def stream(self, run: RunContext) -> AsyncIterator[AgentEvent]:
        runtime_spec(run.runtime)
        if run.runtime == 'codex' and not run.runtime_model:
            # Codex launch isolates user config; carry only its resolved model into this turn.
            from opendirector.agent.catalog import model_choices
            choices = await model_choices('codex')
            default = next((item['id'] for item in choices if item.get('isDefault')), None)
            if default:
                run = replace(run, runtime_model=default)
        gateway = ToolGateway(self.business, run)
        try:
            adapter = self.jiuwenswarm if run.runtime == 'jiuwenswarm' else self.adapter
            async with aclosing(adapter.stream(run, gateway)) as stream:
                async for event in stream:
                    yield event
        finally:
            await gateway.close()
