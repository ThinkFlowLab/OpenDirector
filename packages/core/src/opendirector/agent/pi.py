"""pi coding agent: one `pi --mode json` process per turn over its JSONL event stream."""
import asyncio

from opendirector.agent.process import terminate
from opendirector.domain.projects import ProjectError


# A turn only inspects media and edits intermediates; project changes go through the CLI.
TOOLS = 'read,bash,write,edit'
THINKING = ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')

APPENDIX = (
    'Video creation work belongs to the OpenDirector project: change it only through the '
    'opendirector command on PATH, never by editing project storage directly. '
    'Pass --operation-id to every command that changes project content.\n'
    'This runtime accepts text and images only. Read images with the read tool and obtain '
    'video frames, audio or other media facts through project media commands before '
    'describing them; never claim to have watched a video or heard audio.'
)


def command(binary: str, *, session_dir, system: str, model: str | None = None) -> list[str]:
    session_dir.mkdir(parents=True, exist_ok=True)
    # print/json/rpc modes never ask for trust, so without --approve the project
    # skills and .pi settings are silently skipped.
    args = [binary, '--mode', 'json', '--print', '--approve', '--tools', TOOLS,
            '--session-dir', str(session_dir),
            '--append-system-prompt', system + '\n\n' + APPENDIX]
    if model:
        args += ['--model', model]
    return args


def events(raw: dict, state: dict) -> list[dict]:
    """Stream deltas, then take the finished message as authoritative text.

    pi retries and compacts within a turn, so text it reports twice must not be
    appended twice, and an attempt it retried must not fail the turn: only the
    last message of `agent_end` decides.
    """
    kind = raw.get('type')
    if kind == 'message_start':
        if (raw.get('message') or {}).get('role') == 'assistant':
            state['shown'] = ''
        return []
    if kind == 'message_update':
        update = raw.get('assistantMessageEvent') or {}
        if update.get('type') == 'text_delta' and update.get('delta'):
            state['shown'] = state.get('shown', '') + update['delta']
            return [{'type': 'delta', 'text': update['delta']}]
        return []
    if kind == 'agent_end':
        # A retried attempt ends with stopReason 'error' too; only the settled
        # last message means the turn failed.
        assistant = [item for item in raw.get('messages') or []
                     if (item or {}).get('role') == 'assistant']
        last = assistant[-1] if assistant else {}
        if last.get('stopReason') == 'error':
            raise ProjectError(last.get('errorMessage') or 'pi 模型调用失败，请检查登录、模型或原生轨迹。', 502)
        return []
    if kind != 'message_end' or (raw.get('message') or {}).get('role') != 'assistant':
        return []
    message = raw['message']
    if message.get('stopReason') == 'error':
        return []
    text = ''.join(part.get('text', '') for part in message.get('content') or []
                   if part.get('type') == 'text')
    shown = state.get('shown', '')
    state['shown'] = text
    if text == shown:
        return []
    return [{'type': 'delta', 'text': text[len(shown):] if text.startswith(shown) else text}]


def parse_models(output: str) -> list[dict]:
    """The listing is a fixed-width table; no field inside a row contains spaces."""
    rows = [line.split() for line in output.splitlines() if line.strip()]
    if not rows or rows[0][:2] != ['provider', 'model']:
        raise ValueError('unexpected --list-models header')
    choices = []
    for row in rows[1:]:
        if len(row) < 6 or row[-2:] not in (['yes', 'yes'], ['yes', 'no'], ['no', 'yes'], ['no', 'no']):
            raise ValueError(f'unexpected --list-models row: {row}')
        identifier = f'{row[0]}/{row[1]}'
        choices.append({'id': identifier, 'label': identifier,
                        'efforts': list(THINKING) if row[-2] == 'yes' else []})
    return choices


async def _run(binary: str, args: list[str], timeout: float) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        binary, *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
        return process.returncode, output.decode('utf-8', 'replace')
    finally:
        await terminate(process, group=True)


async def model_choices(binary: str) -> list[dict]:
    try:
        code, output = await _run(binary, ['--list-models'], 20)
        if code:
            raise ProjectError('读取 Pi 模型列表失败，请检查本机配置。', 503)
        return parse_models(output)
    except (OSError, TimeoutError, ValueError) as error:
        raise ProjectError('无法读取 Pi 模型列表，请检查本机 Pi 配置。', 503) from error


async def readiness(binary: str) -> str:
    try:
        code, _ = await _run(binary, ['--version'], 10)
        if code:
            return 'unknown'
        choices = await model_choices(binary)
    except (OSError, TimeoutError, ProjectError):
        return 'unknown'
    if not choices:
        return 'needs_configuration'
    providers = list(dict.fromkeys(item['id'].split('/', 1)[0] for item in choices))
    try:
        for provider in providers:
            code, _ = await _run(binary, ['auth', 'check', '--provider', provider, '--json'], 20)
            if code == 0:
                return 'ready'
    except (OSError, TimeoutError):
        return 'unknown'
    return 'needs_login'
