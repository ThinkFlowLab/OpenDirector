import codecs
import os
from pathlib import Path
import subprocess
import time

import pytest
from typer.testing import CliRunner

from process_helpers import assert_process_exited

from opendirector import cli
from opendirector.agent import windows_powershell


@pytest.mark.parametrize(('source', 'bom'), [
    ('stdin', b''),
    ('stdin', codecs.BOM_UTF8),
    ('file', b''),
    ('file', codecs.BOM_UTF8),
    pytest.param('powershell', codecs.BOM_UTF8,
                 marks=pytest.mark.skipif(os.name != 'nt', reason='Windows PowerShell test')),
])
def test_json_input_is_utf8_with_optional_bom(tmp_path, monkeypatch, source, bom):
    title = '窗边的小猫 𠮷🐈?'
    data = '{"payload":{"text":"%s","name":"story.md"}}' % title
    received = []

    def execute(client, kind, payload, versions, preview):
        received.append(payload)
        return {'status': 'applied'}

    monkeypatch.setattr(cli.Client, 'execute', execute)
    if source == 'stdin':
        result = CliRunner().invoke(cli.app, ['asset', 'write-text', '--file', '-'], input=bom + data.encode())
    else:
        path = tmp_path / 'command.json'
        if source == 'powershell':
            subprocess.run([str(windows_powershell.system_powershell()), '-NoProfile',
                            '-ExecutionPolicy', 'Restricted', '-Command',
                            f"Set-Content -Path command.json -Encoding UTF8 -Value '{data}'"],
                           cwd=tmp_path, capture_output=True, check=True, timeout=10)
            assert path.read_bytes().startswith(bom)
        else:
            path.write_bytes(bom + data.encode())
        result = CliRunner().invoke(cli.app, ['asset', 'write-text', '--file', str(path)])
    assert result.exit_code == 0, result.exception
    assert received == [{'text': title, 'name': 'story.md'}]


@pytest.mark.parametrize('source', ['stdin', 'file'])
def test_json_input_rejects_invalid_utf8_before_dispatch(tmp_path, monkeypatch, source):
    def execute(*args):
        pytest.fail('invalid input reached the project gateway')

    monkeypatch.setattr(cli.Client, 'execute', execute)
    data = b'{"payload":{"name":"story.md","text":"\xff"}}'
    if source == 'stdin':
        result = CliRunner().invoke(cli.app, ['asset', 'write-text', '--file', '-'], input=data)
    else:
        path = tmp_path / 'command.json'
        path.write_bytes(data)
        result = CliRunner().invoke(cli.app, ['asset', 'write-text', '--file', str(path)])
    assert result.exit_code == 1
    assert isinstance(result.exception, UnicodeDecodeError)


@pytest.mark.skipif(os.name != 'nt', reason='Windows PowerShell test')
def test_powershell_launcher_preserves_command_semantics(tmp_path):
    shell = windows_powershell.system_powershell()
    wrapped = windows_powershell.make_launcher(tmp_path)
    commands = [
        ('using namespace System.Text\n[Encoding]::UTF8.WebName', 0, b'utf-8'),
        ('param([string]$x = "two words")\n$x', 0, b'two words'),
        ("Write-Output ('猫' * 5000).Length", 0, b'5000'),
        ('cmd /d /c exit 23', 1, b''),
        ('exit 23', 23, b''),
        ("cmd /d /c exit 23\n'He said \"hello\"' # trailing comment", 0, b'He said "hello"'),
    ]
    for engine in (shell, wrapped):
        for script, code, output in commands:
            result = subprocess.run([str(engine), '-NoProfile', '-ExecutionPolicy', 'Restricted',
                                     '-Command', script], capture_output=True, timeout=10)
            assert (result.returncode, result.stdout.strip()) == (code, output), result.stderr


@pytest.mark.skipif(os.name != 'nt', reason='Windows process tree test')
def test_powershell_launcher_cancel_kills_child(tmp_path):
    wrapped = windows_powershell.make_launcher(tmp_path)
    marker = tmp_path / 'shell.pid'
    script = "[IO.File]::WriteAllText('shell.pid', [string]$PID); Start-Sleep 60"
    proc = subprocess.Popen([str(wrapped), '-NoProfile', '-Command', script], cwd=tmp_path,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        pid = int(marker.read_text())
    finally:
        if proc.poll() is None:
            subprocess.run(['taskkill', '/pid', str(proc.pid), '/f', '/t'], check=True, capture_output=True)
        proc.wait(timeout=10)
    # taskkill can return before Windows has signaled every descendant handle.
    deadline = time.monotonic() + 5
    while True:
        try:
            assert_process_exited(pid)
            break
        except AssertionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)
