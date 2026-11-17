"""Exercise the installed CLI adapter against the shared deployment implementation."""
import json
import sys

import pytest
from typer.testing import CliRunner

from opendirector import cli
from tools import vllm_omni
from tools.vllm_omni import verify


@pytest.fixture(autouse=True)
def source_mapping(monkeypatch):
    # Editable source tests use the same files that are mapped into the wheel.
    monkeypatch.setitem(sys.modules, 'opendirector.vllm_omni', vllm_omni)


def test_cli_help_discovers_operations_and_options():
    runner = CliRunner()
    for command, words in [([], ['vllm-omni']), (['vllm-omni'], ['deploy', 'verify']),
                           (['vllm-omni', 'deploy'], ['doctor', 'plan', 'download', '--root', '--gpu', 'qwen3-tts-06b']),
                           (['vllm-omni', 'verify'], ['--infer', '--audio-file', '--expected-text'])]:
        result = runner.invoke(cli.app, [*command, '--help'], color=False)
        assert result.exit_code == 0, result.output
        for word in words:
            assert word in result.output


@pytest.mark.parametrize('profile', ['zimage-bf16', 'qwen3-tts-06b', 'qwen3-asr-06b'])
def test_deploy_status_loads_each_profile_without_creating_root(tmp_path, profile):
    root = tmp_path / 'absent'
    result = CliRunner().invoke(cli.app, ['vllm-omni', 'deploy', '--root', str(root),
                                        '--profile', profile, 'status'])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)['status'] == 'stopped'
    assert not root.exists()


def test_cli_preserves_structured_failure_and_verification_options(tmp_path, monkeypatch):
    runner = CliRunner()
    result = runner.invoke(cli.app, ['vllm-omni', 'deploy', '--root', str(tmp_path),
                                     '--profile', 'missing', 'status'])
    assert result.exit_code == 1
    assert json.loads(result.output)['code'] == 'unknown_profile'
    calls = []
    monkeypatch.setattr(verify, 'verify', lambda *args, **kwargs: calls.append((args, kwargs)) or {'status': 'ok'})
    result = runner.invoke(cli.app, ['vllm-omni', 'verify', '--root', str(tmp_path),
        '--profile', 'qwen3-asr-06b', '--url', 'http://localhost:8093/v1', '--infer',
        '--audio-file', str(tmp_path / 'speech.wav'), '--expected-text=-Hello world', '--timeout', '30'])
    assert result.exit_code == 0, result.output
    args, kwargs = calls[0]
    assert args[1]['id'] == 'qwen3-asr-06b'
    assert kwargs == dict(infer=True, url='http://localhost:8093/v1', timeout=30,
                          audio_file=tmp_path / 'speech.wav', expected_text='-Hello world')
