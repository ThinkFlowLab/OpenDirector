"""Exercise the actual collection hook before pytest's mark deselection."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

pytestmark = [pytest.mark.cpu, pytest.mark.ready]
ROOT = Path(__file__).resolve().parents[1]


def run_sample(tmp_path, source, *options):
    path = tmp_path / 'test_sample.py'
    path.write_text('import pytest\n' + source, encoding='utf-8')
    report = tmp_path / 'profile.json'
    result = subprocess.run([
        sys.executable, '-m', 'pytest', str(path), '--noconftest',
        '-p', 'ci_hardware', '-p', 'ci_profile', '-c', str(ROOT / 'pyproject.toml'),
        '-q', '--strict-markers', '--ci-profile=' + str(report), *options,
    ], env={**os.environ, 'PYTHONPATH': str(ROOT / 'tests'),
            'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTEST_ADDOPTS': ''},
        capture_output=True, text=True, encoding='utf-8', timeout=30)
    return result, report


def test_cpu_default_precedes_deselection_and_preserves_layers(tmp_path):
    result, report = run_sample(tmp_path, '''
@pytest.mark.ready
def test_default(): pass
@pytest.mark.cpu
@pytest.mark.merge
def test_explicit(): pass
@pytest.mark.cuda
def test_accelerator(): assert False
''', '-m', 'cpu')
    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(report.read_text(encoding='utf-8'))
    assert data['collected_count'] == 2 and data['deselected_count'] == 1
    assert data['hardware'] == {'cpu': 2}
    assert sorted(t['hardware_migration_default'] for t in data['tests']) == [False, True]
    assert data['layers'] == {'ready': 1, 'merge': 1}


@pytest.mark.parametrize('marks', [
    '@pytest.mark.cpu\n@pytest.mark.cuda',
    '@pytest.mark.gpu\n@pytest.mark.rocm',
    'pytestmark = pytest.mark.cpu\n@pytest.mark.npu',
])
def test_conflicts_fail_even_if_cpu_filter_would_hide_them(tmp_path, marks):
    result, _ = run_sample(tmp_path, marks + '\ndef test_conflict(): pass\n', '-m', 'cpu')
    assert result.returncode == 4, result.stdout + result.stderr
    assert 'Conflicting hardware platforms' in result.stderr


@pytest.mark.parametrize('platform', ['gpu', 'cuda', 'rocm', 'xpu', 'npu'])
def test_reserved_platform_is_not_mislabeled_cpu(tmp_path, platform):
    result, report = run_sample(tmp_path,
        '@pytest.mark.' + platform + '\ndef test_reserved(): pass\n')
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(report.read_text(encoding='utf-8'))['hardware'] == {platform: 1}
