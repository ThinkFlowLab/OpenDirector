"""Exercise the actual aggregate command against failure/skip/cancel receipts."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


pytestmark = pytest.mark.ready
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/ci/summarize_checks.py'


def run_summary(tmp_path, statuses, enabled=True):
    summary = tmp_path / 'summary.md'
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        env={**os.environ, 'CHECK_RESULTS': json.dumps({
            lane: {'result': status} for lane, status in statuses.items()
        }), 'STATIC_ENABLED': json.dumps(enabled), 'GITHUB_STEP_SUMMARY': str(summary),
            'PYTHONIOENCODING': 'utf-8'},
        capture_output=True, text=True, encoding='utf-8', timeout=10,
    )
    return result, summary


def test_success_writes_summary(tmp_path):
    result, summary = run_summary(tmp_path, dict.fromkeys(
        ['static', 'python', 'frontend', 'browser'], 'success'))
    assert result.returncode == 0, result.stderr
    assert '| browser | success |' in summary.read_text(encoding='utf-8')


@pytest.mark.parametrize('lane', ['static', 'python', 'frontend', 'browser'])
@pytest.mark.parametrize('status', ['failure', 'cancelled', 'skipped'])
def test_unsuccessful_required_lane_blocks_merge(tmp_path, lane, status):
    statuses = dict.fromkeys(['static', 'python', 'frontend', 'browser'], 'success')
    statuses[lane] = status
    result, _ = run_summary(tmp_path, statuses)
    assert result.returncode != 0
    assert lane in result.stderr


def test_static_failure_and_skipped_test_jobs_do_not_pass(tmp_path):
    result, _ = run_summary(tmp_path, {
        'static': 'failure', 'python': 'skipped',
        'frontend': 'skipped', 'browser': 'skipped',
    })
    assert result.returncode != 0


def test_intentionally_disabled_static_lane_is_allowed(tmp_path):
    result, _ = run_summary(tmp_path, {
        'static': 'skipped', 'python': 'success',
        'frontend': 'success', 'browser': 'success',
    }, enabled=False)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('missing', ['static', 'python', 'frontend', 'browser'])
def test_missing_receipt_fails_closed(tmp_path, missing):
    statuses = dict.fromkeys(['static', 'python', 'frontend', 'browser'], 'success')
    del statuses[missing]
    result, _ = run_summary(tmp_path, statuses)
    assert result.returncode != 0
