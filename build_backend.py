"""PEP 517/660 backend: build web and native resources for both pip install modes."""
import os
import platform
import json
from pathlib import Path
import shutil
import subprocess

from setuptools import build_meta

ROOT = Path(__file__).resolve().parent


def prepare_resources():
    npm = shutil.which('npm')
    if not npm:
        raise RuntimeError('Building OpenDirector from source requires Node.js 24.22.1+ and npm. '
                           'Install Node.js, then retry pip install -e . / 从源码安装需要 Node.js 和 npm。')
    for command in ([npm, 'ci'], [npm, 'run', 'build']):
        print('OpenDirector build: ' + ' '.join(command), flush=True)
        subprocess.run(command, cwd=ROOT, check=True)
    bundled = ROOT / 'packages/core/src/opendirector/_bundled'
    if bundled.exists():
        shutil.rmtree(bundled)
    shutil.copytree(ROOT / 'dist', bundled / 'web')
    skill_ignore = shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo')
    shutil.copytree(ROOT / 'packages/agent/skills', bundled / 'skills', ignore=skill_ignore)
    h3_skill = ROOT / '.agents/upstream/minimax-h3/skills/h3-prompt-writing'
    if (h3_skill / 'SKILL.md').is_file():
        shutil.copytree(h3_skill, bundled / 'skills/h3-prompt-writing', ignore=skill_ignore)
    npm_package = ROOT / 'node_modules/opencode-ai'
    metadata = json.loads((npm_package / 'package.json').read_text())
    if os.name == 'nt':
        arch = {'AMD64': 'x64', 'ARM64': 'arm64'}[platform.machine().upper()]
        executable = npm_package.parent / f'opencode-windows-{arch}' / 'bin/opencode.exe'
    else:
        executable = npm_package / metadata['bin']['opencode']
    subprocess.run([str(executable), '--version'], check=True, cwd=ROOT)
    (bundled / 'bin').mkdir()
    shutil.copy2(executable.resolve(), bundled / 'bin' / ('opencode.exe' if os.name == 'nt' else 'opencode'))
    license_file = ROOT / 'node_modules/opencode-ai/LICENSE'
    if license_file.is_file():
        shutil.copy2(license_file, bundled / 'bin/LICENSE.opencode')


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    prepare_resources()
    return build_meta.build_wheel(wheel_directory, config_settings, metadata_directory)


def build_editable(wheel_directory, config_settings=None, metadata_directory=None):
    prepare_resources()
    return build_meta.build_editable(wheel_directory, config_settings, metadata_directory)


build_sdist = build_meta.build_sdist
get_requires_for_build_wheel = build_meta.get_requires_for_build_wheel
get_requires_for_build_editable = build_meta.get_requires_for_build_editable
get_requires_for_build_sdist = build_meta.get_requires_for_build_sdist
prepare_metadata_for_build_wheel = build_meta.prepare_metadata_for_build_wheel
prepare_metadata_for_build_editable = build_meta.prepare_metadata_for_build_editable
