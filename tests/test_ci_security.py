"""Keep every PR scanned, and execute the stable security aggregate command."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

import pytest
import yaml


pytestmark = [pytest.mark.cpu, pytest.mark.ready]
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def workflow():
    return yaml.safe_load((ROOT / '.github/workflows/codeql.yml').read_text(encoding='utf-8'))


def test_every_pr_including_docs_and_forks_has_security_checks(workflow):
    # PyYAML's YAML 1.1 loader parses GitHub's `on` key as boolean True.
    events = workflow[True]
    assert events['pull_request'] is None
    assert events['push'] == {'branches': ['main']}
    assert 'workflow_dispatch' in events
    assert 'pull_request_target' not in events
    assert workflow['name'] == 'CodeQL'
    assert workflow['permissions'] == {'contents': 'read'}
    analyze = workflow['jobs']['analyze']
    assert 'if' not in analyze and 'needs' not in analyze
    assert {'python', 'javascript-typescript'} <= set(analyze['strategy']['matrix']['language'])
    assert analyze['strategy']['fail-fast'] is False
    assert analyze['timeout-minutes'] == 30


def test_source_analysis_uses_pinned_actions_and_limited_permissions(workflow):
    job = workflow['jobs']['analyze']
    assert job['permissions'] == {'contents': 'read', 'actions': 'read', 'security-events': 'write'}
    steps = job['steps']
    assert len(steps) == 4
    assert steps[0]['with']['persist-credentials'] is False
    assert all(re.fullmatch(r'[^@]+@[0-9a-f]{40}', step['uses']) for step in steps)
    initialize, analyze, evidence = steps[1:]
    assert initialize['uses'].startswith('github/codeql-action/init@')
    assert analyze['uses'].startswith('github/codeql-action/analyze@')
    assert initialize['uses'].split('@')[1] == analyze['uses'].split('@')[1]
    assert initialize['with'] == {
        'languages': '${{ matrix.language }}', 'build-mode': 'none', 'queries': 'security-extended',
    }
    assert analyze['with'] == {
        'category': '/language:${{ matrix.language }}', 'wait-for-processing': True,
        'output': '${{ runner.temp }}/codeql-results',
        'upload': "${{ github.event_name == 'merge_group' && 'never' || 'always' }}",
    }
    assert not any('run' in step or 'continue-on-error' in step or 'if' in step for step in steps[:3])
    assert evidence['if'] == "github.event_name == 'merge_group'"
    assert evidence['uses'].startswith('actions/upload-artifact@')
    assert evidence['with']['path'] == '${{ runner.temp }}/codeql-results/*.sarif'
    assert evidence['with']['if-no-files-found'] == 'error'
    assert 'secrets.' not in str(job)


@pytest.mark.parametrize('status', ['success', 'failure', 'cancelled', 'skipped', 'timed_out', '', 'unknown', None])
def test_actual_aggregate_command_rejects_every_unsettled_result(workflow, status):
    job = workflow['jobs']['checks']
    assert job['name'] == 'CodeQL / checks'
    assert job['if'] == 'always()' and job['needs'] == 'analyze'
    assert 'continue-on-error' not in job
    step = job['steps'][0]
    assert step['env'] == {'ANALYSIS_RESULT': '${{ needs.analyze.result }}'}
    assert 'if' not in step and 'continue-on-error' not in step
    args = shlex.split(step['run'])
    assert args[:2] == ['python', '-c']
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
    env.pop('ANALYSIS_RESULT', None)
    if status is not None:
        env['ANALYSIS_RESULT'] = status
    result = subprocess.run([sys.executable, *args[1:]], env=env,
                            capture_output=True, text=True, encoding='utf-8', timeout=10)
    assert (result.returncode == 0) == (status == 'success'), result.stderr
    assert 'CodeQL analysis' in result.stdout
