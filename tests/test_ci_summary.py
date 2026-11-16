"""Exercise the actual aggregate command against failure/skip/cancel receipts."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


pytestmark = pytest.mark.ready
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/ci/summarize_checks.py'


def run_summary(tmp_path, statuses, enabled=True, *, scope=None, event='pull_request'):
    summary = tmp_path / 'summary.md'
    results = {lane: {'result': status} for lane, status in statuses.items()}
    if scope is not None:
        results['static']['outputs'] = scope
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        env={**os.environ, 'CHECK_RESULTS': json.dumps(results), 'GITHUB_EVENT_NAME': event,
            'STATIC_ENABLED': json.dumps(enabled), 'GITHUB_STEP_SUMMARY': str(summary),
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


DOC_SCOPE = {'run-heavy': 'false', 'scope-reason': 'docs_only', 'changed-files': '2'}
DOC_RESULTS = {'static': 'success', 'python': 'skipped', 'frontend': 'skipped', 'browser': 'skipped'}


def test_proven_docs_only_skip_succeeds_and_reports_reason(tmp_path):
    result, summary = run_summary(tmp_path, DOC_RESULTS, scope=DOC_SCOPE)
    assert result.returncode == 0, result.stderr
    text = summary.read_text(encoding='utf-8')
    assert 'Documentation-only PR' in text and 'docs_only' in text
    assert '| browser | skipped |' in text


@pytest.mark.parametrize('lane', ['static', 'python', 'frontend', 'browser'])
@pytest.mark.parametrize('status', ['failure', 'cancelled'])
def test_docs_only_never_hides_failed_or_cancelled_jobs(tmp_path, lane, status):
    result, _ = run_summary(tmp_path, {**DOC_RESULTS, lane: status}, scope=DOC_SCOPE)
    assert result.returncode != 0


@pytest.mark.parametrize('scope', [
    {}, {'run-heavy': 'false'}, {**DOC_SCOPE, 'scope-reason': 'comparison_unavailable'},
    {**DOC_SCOPE, 'changed-files': '0'}, {**DOC_SCOPE, 'changed-files': 'unknown'},
    {**DOC_SCOPE, 'run-heavy': 'invalid'},
])
def test_missing_or_invalid_skip_evidence_fails_closed(tmp_path, scope):
    result, _ = run_summary(tmp_path, DOC_RESULTS, scope=scope)
    assert result.returncode != 0


@pytest.mark.parametrize('event', ['push', 'schedule', 'workflow_dispatch', 'merge_group'])
def test_other_events_cannot_claim_docs_only_skip(tmp_path, event):
    result, _ = run_summary(tmp_path, DOC_RESULTS, scope=DOC_SCOPE, event=event)
    assert result.returncode != 0


def test_disabled_static_cannot_authorize_heavy_skip(tmp_path):
    result, _ = run_summary(tmp_path, DOC_RESULTS, enabled=False, scope=DOC_SCOPE)
    assert result.returncode != 0


@pytest.mark.parametrize('missing', ['static', 'python', 'frontend', 'browser'])
def test_docs_only_still_requires_every_lane_receipt(tmp_path, missing):
    statuses = dict(DOC_RESULTS)
    del statuses[missing]
    result, _ = run_summary(tmp_path, statuses, scope=DOC_SCOPE if missing != 'static' else None)
    assert result.returncode != 0
