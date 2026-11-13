"""Verify timing evidence against actual isolated pytest runs."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


pytestmark = pytest.mark.ready
ROOT = Path(__file__).resolve().parents[1]
SAMPLE = '''import pytest
@pytest.mark.ready
def test_ready(): pass
@pytest.mark.merge
def test_merge(): assert False, "failure text must not enter JSON"
@pytest.mark.nightly
@pytest.mark.skip(reason="opt-in")
def test_nightly(): pass
def test_unmarked(): pass
'''


def run_sample(tmp_path, *extra, profile=True, source=SAMPLE):
    sample = tmp_path / 'test_sample.py'
    sample.write_text(source, encoding='utf-8')
    report = tmp_path / 'profile.json'
    args = [sys.executable, '-m', 'pytest', str(sample), '--noconftest',
            '-p', 'ci_profile', '-c', str(ROOT / 'pyproject.toml'), '-q', *extra]
    if profile:
        args.append('--ci-profile=' + str(report))
    result = subprocess.run(args, cwd=ROOT, env={
        **os.environ, 'PYTHONPATH': str(ROOT / 'tests'),
        'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1', 'PYTHONIOENCODING': 'utf-8',
        'PYTEST_ADDOPTS': '',
        'GITHUB_SHA': 'a' * 40, 'GITHUB_STEP_SUMMARY': str(tmp_path / 'job-summary.md'),
    }, capture_output=True, text=True, encoding='utf-8', timeout=30)
    return result, report


def test_records_failures_skips_durations_layers_and_identity(tmp_path):
    result, path = run_sample(tmp_path)
    assert result.returncode == 1, result.stdout + result.stderr
    data = json.loads(path.read_text(encoding='utf-8'))
    assert data['complete'] is True and data['exit_status'] == 1
    assert data['collection_complete'] is True and data['collected_count'] == 4
    assert data['metadata']['sha'] == 'a' * 40
    assert data['metadata']['platform']
    assert data['counts'] == {'passed': 2, 'failed': 1, 'skipped': 1}
    assert data['layers'] == {'ready': 2, 'merge': 1, 'nightly': 1}
    assert data['unmarked'] == 1
    assert sum(data['modules'].values()) == pytest.approx(sum(row['seconds'] for row in data['tests']))
    passed = next(row for row in data['tests'] if row['nodeid'].endswith('test_ready'))
    assert set(passed['durations']) == {'setup', 'call', 'teardown'}
    assert passed['seconds'] >= 0
    assert 'failure text must not enter JSON' not in path.read_text(encoding='utf-8')
    assert path.with_suffix('.md').is_file()
    assert 'Python' in (tmp_path / 'job-summary.md').read_text(encoding='utf-8')


def test_selection_is_preserved_and_unmarked_stays_in_ready(tmp_path):
    result, path = run_sample(tmp_path, '-m', 'ready or (not merge and not nightly)')
    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(path.read_text(encoding='utf-8'))
    assert data['complete'] is True
    assert data['counts'] == {'passed': 2}
    assert data['unmarked'] == 1
    assert data['metadata']['selection'] == 'ready or (not merge and not nightly)'
    assert data['deselected_count'] == 2


def test_maxfail_does_not_claim_a_complete_measurement(tmp_path):
    result, path = run_sample(tmp_path, '-x')
    assert result.returncode == 1
    data = json.loads(path.read_text(encoding='utf-8'))
    assert data['complete'] is False
    assert data['counts']['not_run'] == 2
    assert not path.with_suffix('.md').exists()


def test_collection_only_does_not_claim_execution(tmp_path):
    result, path = run_sample(tmp_path, '--collect-only')
    assert result.returncode == 0
    data = json.loads(path.read_text(encoding='utf-8'))
    assert data['complete'] is False
    assert data['counts'] == {'not_run': 4}
    assert data['collection_complete'] is True and data['collected_count'] == 4


def test_profile_is_opt_in_and_does_not_change_exit_status(tmp_path):
    result, path = run_sample(tmp_path, profile=False)
    assert result.returncode == 1
    assert not path.exists()


def test_conflicting_marks_are_visible_without_reclassifying(tmp_path):
    sample = SAMPLE.replace('@pytest.mark.merge', '@pytest.mark.ready\n@pytest.mark.merge')
    result, path = run_sample(tmp_path, source=sample)
    assert result.returncode == 1
    data = json.loads(path.read_text(encoding='utf-8'))
    assert data['layers']['conflict'] == 1
    assert next(row for row in data['tests'] if row['effective_layer'] == 'conflict')['explicit_layers'] == ['merge', 'ready']
