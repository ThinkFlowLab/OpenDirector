"""Real Windows shells, generated launchers, gateway receipts and persisted bytes."""
import asyncio
import base64
import json
import os
import shutil
from uuid import uuid4

import pytest

from opendirector.agent.cli_transport import turn_environment
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs


pytestmark = [pytest.mark.merge, pytest.mark.skipif(os.name != 'nt', reason='Requires real Windows launchers')]
TEXT = '# 暖阳窗边的小橘猫 🐈 𠮷\r\n镜头一："推近" & 咖啡 | 100%\n镜头二：C:\\素材\\片尾\\\n'


@pytest.fixture
def project_cli(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path / '项目 with spaces'))
    pid, turn, session = uuid4(), uuid4(), str(uuid4())
    projects.execute(parse_command({'type': 'project.create', 'projectId': pid,
        'commandId': uuid4(), 'payload': {'name': '中文传输'}}))
    projects.open(pid, session)
    with projects.local.transaction() as db:
        directory, _, _ = projects._load(db, pid)
    work = directory / 'agent-runs' / str(turn) / 'work'
    work.mkdir(parents=True)
    configs = ModelConfigs(tmp_path)
    run = RunContext(runtime='opencode', project_id=pid, turn_id=turn, session=session,
        directory=directory, config=None, messages=[], selected_skills=[])
    return projects, configs, run, work, tmp_path


async def invoke(project_cli, arguments, *, script=None, shell=None):
    projects, configs, run, work, temporary = project_cli
    gateway = ToolGateway(AgentTools(projects, None, configs), run)
    queue = asyncio.Queue()
    async with turn_environment(work, gateway, queue, temporary) as env:
        if script is None:
            command = [str(work / '.opendirector-bin/opendirector.exe'), *arguments]
        else:
            source = script + '\nexit $LASTEXITCODE\n'
            encoded = base64.b64encode(source.encode('utf-16-le')).decode('ascii')
            command = [shell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
        process = await asyncio.create_subprocess_exec(*command, cwd=work, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
        return process.returncode, stdout.decode('utf-8'), stderr.decode('utf-8'), events


@pytest.mark.parametrize('shell_name', ['powershell', 'pwsh'])
@pytest.mark.parametrize('mode', ['argument', 'pipeline', 'bom-file', 'generation'])
def test_windows_shell_preserves_unicode_in_project(project_cli, shell_name, mode):
    shell = shutil.which(shell_name)
    if shell is None:
        pytest.skip(f'{shell_name} is not installed')
    projects, configs, run, work, _ = project_cli
    name = '暖阳窗边的小橘猫 🐈.md'
    payload = {'payload': {'name': name, 'text': TEXT}}
    if mode == 'generation':
        model = configs.save('image', 'http://image.test/v1', 'test-image', '', auth_mode='none')['id']
        spec, item = str(uuid4()), str(uuid4())
        payload = {'payload': {
            'spec': {'id': spec, 'projectId': str(run.project_id), 'kind': 'image', 'purpose': 'generation',
                'modelConfigId': model, 'prompt': TEXT, 'parameters': {'size': '1024x1024'}},
            'item': {'id': item, 'projectId': str(run.project_id), 'kind': 'image', 'title': name,
                'position': {'x': 0, 'y': 0}, 'width': 512, 'height': 512,
                'binding': {'role': 'generation', 'objectRef': {'id': spec}}}}}
    encoded = json.dumps(payload, ensure_ascii=False).replace("'", "''")
    # Reproduce a caller whose native pipeline encoding cannot represent Chinese.
    script = '$OutputEncoding = [System.Text.Encoding]::ASCII\n'
    script += '$originalOutputEncoding = $global:OutputEncoding\n$originalConsoleEncoding = [Console]::OutputEncoding\n'
    if mode == 'argument':
        script += "$data = '" + encoded + "' | ConvertFrom-Json\nopendirector asset write-text --name $data.payload.name --text $data.payload.text\n"
    elif mode == 'bom-file':
        (work / '中文 参数.json').write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8-sig')
        script += "opendirector asset write-text --file '中文 参数.json'\n"
    else:
        command = 'canvas create-generation' if mode == 'generation' else 'asset write-text'
        script += "'" + encoded + "' | ConvertFrom-Json | ConvertTo-Json -Depth 12 -Compress | opendirector " + command + ' --file -\n'
    script += ('if ($global:OutputEncoding -ne $originalOutputEncoding -or '
        '[Console]::OutputEncoding.CodePage -ne $originalConsoleEncoding.CodePage) { throw "Caller encoding was changed" }\n')
    code, stdout, stderr, events = asyncio.run(invoke(project_cli, [], script=script, shell=shell))
    assert code == 0, (stdout, stderr)
    receipt = json.loads(stdout)
    assert receipt['status'] == 'applied'
    assert all(event['status'] == 'complete' for event in events if event.get('status') != 'running')
    # Reopen storage: UI text or a successful receipt alone cannot prove fidelity.
    snapshot = CreationProjects(LocalProjects(projects.local.repository)).snapshot(run.project_id)
    if mode == 'generation':
        assert snapshot.canvasItems[0].title == name
        assert snapshot.generationSpecs[0].prompt == TEXT
        assert snapshot.assets == ()
    else:
        asset, = snapshot.assets
        assert asset.name == name
        assert (run.directory / asset.path).read_bytes() == TEXT.encode('utf-8')
        assert asset.provenance.agentRuntime == 'opencode'


def test_native_launcher_preserves_multiline_arguments_and_exit_codes(project_cli):
    projects, _, run, _, _ = project_cli
    code, stdout, stderr, _ = asyncio.run(invoke(project_cli,
        ['asset', 'write-text', '--name', '原生入口𠮷.md', '--text', TEXT]))
    assert code == 0, (stdout, stderr)
    assert json.loads(stdout)['status'] == 'applied'
    asset, = projects.snapshot(run.project_id).assets
    assert asset.name == '原生入口𠮷.md'
    assert (run.directory / asset.path).read_bytes() == TEXT.encode('utf-8')
    code, _, _, _ = asyncio.run(invoke(project_cli, ['asset', 'write-text', '--unknown-option']))
    assert code == 2


@pytest.mark.parametrize('shell_name', ['powershell', 'pwsh'])
def test_powershell_launcher_preserves_failure_exit_code(project_cli, shell_name):
    shell = shutil.which(shell_name)
    if shell is None:
        pytest.skip(f'{shell_name} is not installed')
    code, _, _, _ = asyncio.run(invoke(project_cli, [],
        script='opendirector asset write-text --unknown-option', shell=shell))
    assert code == 2
