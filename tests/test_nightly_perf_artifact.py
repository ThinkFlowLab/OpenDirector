"""Nightly perf artifact layout: the daily benchmark must find this run's sample (#299).

actions/upload-artifact roots an artifact at the least common ancestor of every
uploaded path. Mixing the workspace-relative report with absolute /tmp profiles
made that ancestor `/`, so the report landed at
`home/runner/work/<repo>/<repo>/nightly-perf.json` inside the artifact while the
consumer only looked for `nightly-perf/nightly-perf.json` and silently dropped
the UI sample. These tests model that rooting rule against the workflow itself.
"""
import posixpath
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/nightly.yml'
WORKSPACE = '/home/runner/work/OpenDirector/OpenDirector'
RUNNER_TEMP = '/home/runner/work/_temp'


def load_jobs():
    return yaml.safe_load(WORKFLOW.read_text(encoding='utf-8'))['jobs']


def step(job, *, uses=None, name=None):
    for candidate in job['steps']:
        if uses and candidate.get('uses', '').startswith(uses):
            if name is None or candidate.get('with', {}).get('name') == name:
                return candidate
        if not uses and candidate.get('name') == name:
            return candidate
    raise AssertionError(f'step not found: uses={uses} name={name}')


def resolve(path):
    path = path.replace('${{ runner.temp }}', RUNNER_TEMP).replace('$RUNNER_TEMP', RUNNER_TEMP)
    return path if path.startswith('/') else posixpath.join(WORKSPACE, path)


def static_prefix(pattern):
    """Directory part of a glob before its first wildcard, as upload-artifact sees it."""
    head = re.split(r'[*?\[]', pattern, maxsplit=1)[0]
    return head.rstrip('/') if head.endswith('/') or head == pattern else posixpath.dirname(head)


def artifact_root(paths):
    """upload-artifact v4 root: the least common ancestor of the search paths.

    A single directory path becomes the root itself; files and globs contribute
    their containing directory.
    """
    resolved = [resolve(p) for p in paths]
    if len(resolved) == 1 and not re.search(r'[*?\[]', resolved[0]) and not resolved[0].endswith('.json'):
        return resolved[0].rstrip('/')
    dirs = [static_prefix(p) if re.search(r'[*?\[]', p) else posixpath.dirname(p) for p in resolved]
    return posixpath.commonpath(dirs)


def upload_paths(job):
    upload = step(job, uses='actions/upload-artifact@', name='nightly-perf')
    return [line.strip() for line in upload['with']['path'].splitlines() if line.strip()]


def report_destination(job):
    """Where the render/drag step writes nightly-perf.json, workspace-resolved."""
    run = step(job, name='Render probe and drag performance')['run']
    match = re.search(r"'\{sha: \$sha.*?\}'\s*>\s*(\S+)", run, re.S)
    assert match, 'perf report write not found'
    return resolve(match.group(1).replace('"', ''))


def consumer_perf_path(job):
    run = step(job, name='Run the fixed suite and compare')['run']
    match = re.search(r'--perf (\S+)\)', run)
    assert match, 'consumer --perf argument not found'
    return match.group(1)


def test_report_is_at_the_artifact_root_where_the_benchmark_reads_it():
    jobs = load_jobs()
    producer = jobs['perf-outputs']
    root = artifact_root(upload_paths(producer))
    member = posixpath.relpath(report_destination(producer), root)
    assert not member.startswith('..'), f'report {member} is outside the uploaded tree'

    download = step(jobs['daily-benchmark'], uses='actions/download-artifact@', name='nightly-perf')
    expected = posixpath.join(download['with']['path'], member)
    assert consumer_perf_path(jobs['daily-benchmark']) == expected
    run = step(jobs['daily-benchmark'], name='Run the fixed suite and compare')['run']
    assert f'if [ -f {expected} ]' in run


def test_profiles_ride_in_the_same_artifact_directory_not_absolute_tmp():
    jobs = load_jobs()
    paths = upload_paths(jobs['perf-outputs'])
    assert all(not p.startswith('/tmp') for p in paths), paths
    root = artifact_root(paths)
    assert root not in ('/', '/home', WORKSPACE), f'artifact root too wide: {root}'
    prepare = ' '.join(s.get('run', '') for s in jobs['perf-outputs']['steps'])
    assert re.search(r'cpuprofile', prepare), 'profiles are no longer staged into the artifact'


def test_missing_sample_still_fails_a_required_ui_lane():
    run = step(load_jobs()['daily-benchmark'], name='Run the fixed suite and compare')['run']
    assert '--ui-required' in run
    assert "needs.perf-outputs.result }}\" = \"success\"" in run


@pytest.mark.parametrize(('paths', 'root'), [
    (['nightly-perf.json', '/tmp/opendirector-drag-nightly-*.cpuprofile'], '/'),
    (['nightly-perf/'], f'{WORKSPACE}/nightly-perf'),
    (['nightly-perf/nightly-perf.json', 'nightly-perf/profiles/*.cpuprofile'], f'{WORKSPACE}/nightly-perf'),
])
def test_rooting_model_matches_upload_artifact(paths, root):
    # The first case is the observed #299 archive: the report sat under
    # home/runner/work/OpenDirector/OpenDirector/ in artifact 13903062139.
    assert artifact_root(paths) == root
