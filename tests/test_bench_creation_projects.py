"""Fixture preparation must outlive the edit lease it holds while building.

The nightly storage lane aborted before measuring anything because preparing a
fixture at the configured 600-commit / 200-node scale took longer than
``LocalProjects.LEASE_SECONDS`` (#260). These tests shrink the lease so the same
ratio is exercised without waiting a minute.
"""
import importlib.util
from pathlib import Path

from opendirector.infrastructure.local_projects import LocalProjects

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/bench_creation_projects.py'

spec = importlib.util.spec_from_file_location('bench_creation_projects', SCRIPT)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class FakeProjects:
    """Records renewal calls so the schedule can be checked without a store."""

    def __init__(self, lease):
        self.local = type('Local', (), {'LEASE_SECONDS': lease})()
        self.renewals = []

    def heartbeat(self, session, project_id):
        self.renewals.append((session, project_id))


def test_keep_alive_renews_immediately_then_on_the_half_lease(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(bench.time, 'monotonic', lambda: clock[0])
    projects = FakeProjects(lease=60)
    renew = bench.keep_alive(projects, 'project', 'session')

    # A fixture can already be partway into its lease when its loop starts, so the
    # first call must renew instead of assuming a fresh window.
    renew()
    assert projects.renewals == [('session', 'project')]

    clock[0] = 29.0
    renew()
    assert len(projects.renewals) == 1, 'half the lease has not passed yet'

    clock[0] = 31.0
    renew()
    assert len(projects.renewals) == 2, 'renewed after the interval passed'

    clock[0] = 60.0
    renew()
    assert len(projects.renewals) == 2, 'the window restarts at the last renewal'

    clock[0] = 62.0
    renew()
    assert len(projects.renewals) == 3


def test_cold_open_fixture_outlives_the_edit_lease(tmp_path, monkeypatch):
    # Preparation here lasts several times the lease, so without renewal the write
    # loop would fail with an expired session before any operation is measured.
    monkeypatch.setattr(LocalProjects, 'LEASE_SECONDS', 0.5)
    result = bench.scenario_cold_open(tmp_path, commits=40, nodes=5, projects_count=0)
    assert result['commits'] == 40
    assert isinstance(result['snapshot'], float)
    assert isinstance(result['open'], float)
