"""Exercise the actual Git range: skips must never hide code or unknown scope."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml


pytestmark = pytest.mark.ready
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/ci/select_checks.py'
spec = importlib.util.spec_from_file_location('check_scope', SCRIPT)
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


def git(repo, *args):
    return subprocess.check_output(
        ['git', '-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', *args],
        cwd=repo, stderr=subprocess.DEVNULL,
    ).decode('utf-8').strip()


@pytest.fixture
def repository(tmp_path):
    git(tmp_path, 'init', '-q')
    for name in ['README.md', 'src/app.py']:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('baseline\n', encoding='utf-8')
    git(tmp_path, 'add', '.')
    git(tmp_path, 'commit', '-qm', 'baseline')
    return tmp_path, git(tmp_path, 'rev-parse', 'HEAD')


def commit(repo, *names):
    for name in names:
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('changed\n', encoding='utf-8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'change')


@pytest.mark.parametrize('names,docs', [
    (['README.md', 'docs/development/validation.md'], True),
    (['docs/guides/images/preview.png', 'docs/guide with spaces.md'], True),
    (['docs/中文说明.md'], True),
    (['docs/guide.md', 'src/app.py'], False),
    (['.github/workflows/ci.yml'], False),
    (['.pre-commit-config.yaml'], False),
    (['requirements.txt'], False),
    (['AGENTS.md'], False),
    (['.agents/skills/example/SKILL.md'], False),
    (['docs/helper.py'], False),
    (['docs/config.json'], False),
    (['tests/README.md'], False),
])
def test_only_allowlisted_nonempty_documentation_can_skip(repository, names, docs):
    repo, base = repository
    commit(repo, *names)
    decision = scope.select('pull_request', base, repository=repo)
    assert decision['run-heavy'] == ('false' if docs else 'true')
    assert decision['scope-reason'] == ('docs_only' if docs else 'non_documentation')
    assert int(decision['changed-files']) == len(names)


def test_whole_pr_not_only_last_commit(repository):
    repo, base = repository
    commit(repo, 'src/app.py')
    commit(repo, 'docs/guide.md')
    assert scope.select('pull_request', base, repository=repo)['run-heavy'] == 'true'


def test_code_renamed_into_docs_is_still_code(repository):
    repo, base = repository
    (repo / 'docs').mkdir()
    git(repo, 'mv', 'src/app.py', 'docs/guide.md')
    git(repo, 'commit', '-qm', 'rename')
    decision = scope.select('pull_request', base, repository=repo)
    assert decision['run-heavy'] == 'true'
    assert decision['changed-files'] == '2'


def test_deleted_document_is_documentation(repository):
    repo, base = repository
    git(repo, 'rm', 'README.md')
    git(repo, 'commit', '-qm', 'remove')
    assert scope.select('pull_request', base, repository=repo)['run-heavy'] == 'false'


def test_merge_base_excludes_unrelated_base_branch_changes(repository):
    repo, base = repository
    commit(repo, 'docs/guide.md')
    tip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-qb', 'base-update', base)
    commit(repo, 'src/base-only.py')
    updated_base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', tip)
    assert scope.select('pull_request', updated_base, repository=repo)['run-heavy'] == 'false'


@pytest.mark.parametrize('event', ['push', 'workflow_dispatch', 'schedule', 'merge_group', None])
def test_other_events_always_keep_full_bar(repository, event):
    repo, base = repository
    commit(repo, 'docs/guide.md')
    decision = scope.select(event, base, repository=repo)
    assert decision['run-heavy'] == 'true'
    assert decision['scope-reason'] == 'event_requires_full'


@pytest.mark.parametrize('base', [None, '', '0' * 40, '--output=unexpected'])
def test_missing_or_invalid_comparison_falls_back_to_full(repository, base):
    repo, _ = repository
    commit(repo, 'docs/guide.md')
    decision = scope.select('pull_request', base, repository=repo)
    assert decision['run-heavy'] == 'true'
    assert decision['scope-reason'] == 'comparison_unavailable'


def test_empty_diff_does_not_authorize_skip(repository):
    repo, base = repository
    assert scope.select('pull_request', base, repository=repo)['scope-reason'] == 'empty_diff'


@pytest.mark.parametrize('failure', [OSError('git unavailable'), subprocess.TimeoutExpired('git', 30)])
def test_git_execution_failure_keeps_full_checks(repository, monkeypatch, failure):
    repo, base = repository
    def failed(*_args, **_kwargs):
        raise failure
    monkeypatch.setattr(scope.subprocess, 'check_output', failed)
    assert scope.select('pull_request', base, repository=repo)['scope-reason'] == 'comparison_unavailable'


@pytest.mark.parametrize('output', [b'docs/guide.md', b'docs/invalid-\xff.md\0'])
def test_unparseable_diff_keeps_full_checks(repository, monkeypatch, output):
    repo, base = repository
    monkeypatch.setattr(scope.subprocess, 'check_output', lambda *_args, **_kwargs: output)
    assert scope.select('pull_request', base, repository=repo)['run-heavy'] == 'true'


def test_real_selector_outputs_drive_real_aggregate(repository, tmp_path):
    repo, base = repository
    commit(repo, 'docs/guide.md')
    output, summary = tmp_path / 'outputs', tmp_path / 'summary'
    env = {**os.environ, 'GITHUB_EVENT_NAME': 'pull_request', 'PR_BASE_SHA': base,
           'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': str(summary), 'PYTHONIOENCODING': 'utf-8'}
    selected = subprocess.run([sys.executable, str(SCRIPT)], cwd=repo, env=env,
                              capture_output=True, text=True, encoding='utf-8', check=True)
    decision = dict(line.split('=', 1) for line in output.read_text(encoding='utf-8').splitlines())
    assert decision == json.loads(selected.stdout)
    results = {'static': {'result': 'success', 'outputs': decision},
               **{lane: {'result': 'skipped'} for lane in ['python', 'frontend', 'browser']}}
    aggregated = subprocess.run([sys.executable, str(ROOT / 'scripts/ci/summarize_checks.py')],
        env={**env, 'CHECK_RESULTS': json.dumps(results), 'STATIC_ENABLED': 'true'},
        capture_output=True, text=True, encoding='utf-8')
    assert aggregated.returncode == 0, aggregated.stderr
    assert 'Documentation-only PR' in summary.read_text(encoding='utf-8')


def test_workflow_wires_every_heavy_lane_to_successful_static_scope():
    jobs = yaml.safe_load((ROOT / '.github/workflows/release-checks.yml').read_text(encoding='utf-8'))['jobs']
    assert jobs['static']['steps'][-1]['id'] == 'scope'
    assert jobs['static']['steps'][-1]['run'] == 'python scripts/ci/select_checks.py'
    assert set(jobs['static']['outputs']) == {'run-heavy', 'scope-reason', 'changed-files'}
    for lane in ['python', 'frontend', 'browser']:
        assert jobs[lane]['needs'] == 'static'
        assert "needs.static.result == 'success' && needs.static.outputs.run-heavy != 'false'" in jobs[lane]['if']
        assert "!inputs.static-checks && needs.static.result == 'skipped'" in jobs[lane]['if']
    assert jobs['checks']['if'] == 'always()'
    assert set(jobs['checks']['needs']) == {'static', 'python', 'frontend', 'browser'}
