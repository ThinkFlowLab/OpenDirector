"""Installed CLI entry points for the isolated local model tools."""
from enum import Enum
from pathlib import Path
import sys
from typing import Annotated

import typer

app = typer.Typer(no_args_is_help=True, help="Deploy and verify isolated local vLLM-Omni model services.")


class Operation(str, Enum):
    doctor = 'doctor'
    plan = 'plan'
    install = 'install'
    download = 'download'
    start = 'start'
    status = 'status'
    stop = 'stop'


class DownloadBackend(str, Enum):
    sdk = 'sdk'
    ranges = 'ranges'


@app.command('deploy', help='Inspect, install, download, start, inspect status or stop a model service. Returns JSON.')
def deploy(
    command: Annotated[Operation, typer.Argument(help='Deployment operation to run.')],
    root: Annotated[Path, typer.Option(help='Directory for model environments, weights and service state.')],
    profile: Annotated[str, typer.Option(help='Profile: zimage-bf16, qwen3-tts-06b or qwen3-asr-06b.')] = 'zimage-bf16',
    gpu: Annotated[str, typer.Option(help='Assigned physical GPU index or full UUID.')] = '',
    python: Annotated[str, typer.Option(help='Python 3.12 interpreter for the isolated model environment.')] = sys.executable,
    hf_endpoint: Annotated[str | None, typer.Option(help='Trusted Hugging Face endpoint for this deployment.')] = None,
    download_backend: Annotated[DownloadBackend, typer.Option(help='Hugging Face SDK or pinned range downloader.')] = DownloadBackend.sdk,
    port: Annotated[int, typer.Option(help='Loopback service port.')] = 8091,
    timeout: Annotated[int, typer.Option(help='Startup observation window in seconds.')] = 600,
):
    from opendirector.vllm_omni import deploy as implementation
    args = [f'--root={root}', f'--profile={profile}', f'--gpu={gpu}', f'--python={python}',
            f'--download-backend={download_backend.value}', f'--port={port}', f'--timeout={timeout}']
    if hf_endpoint is not None:
        args.append(f'--hf-endpoint={hf_endpoint}')
    raise typer.Exit(implementation.main([*args, command.value]))


@app.command('verify', help='Check service readiness or submit one real verification request. Returns JSON.')
def verify(
    root: Annotated[Path, typer.Option(help='Deployment data directory.')],
    profile: Annotated[str, typer.Option(help='Profile: zimage-bf16, qwen3-tts-06b or qwen3-asr-06b.')] = 'zimage-bf16',
    url: Annotated[str | None, typer.Option(help='Existing service API base URL ending in /v1.')] = None,
    infer: Annotated[bool, typer.Option(help='Submit one real request; save and inspect the result.')] = False,
    timeout: Annotated[int, typer.Option(help='Request timeout in seconds.')] = 240,
    audio_file: Annotated[Path | None, typer.Option(help='ASR input file, at most 25 MiB.')] = None,
    expected_text: Annotated[str | None, typer.Option(help='Optional local ASR comparison text, never sent to the model.')] = None,
):
    from opendirector.vllm_omni import verify as implementation
    args = [f'--root={root}', f'--profile={profile}', f'--timeout={timeout}']
    for option, value in [('--url', url), ('--audio-file', audio_file), ('--expected-text', expected_text)]:
        if value is not None:
            args.append(f'{option}={value}')
    if infer:
        args.append('--infer')
    raise typer.Exit(implementation.main(args))
