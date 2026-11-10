"""The storage benchmark keeps its fixture's edit lease while building it (#260)."""
import importlib.util
from pathlib import Path
import time
from types import SimpleNamespace

import pytest

from opendirector.infrastructure import creation_projects, local_projects

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bench_creation_projects', ROOT / 'scripts/bench_creation_projects.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


@pytest.mark.parametrize('scenario, measured', [
    (bench.scenario_cold_open, {'list_projects', 'snapshot', 'open', 'snapshot_after_open'}),
    (bench.scenario_delete, {'client_snapshot', 'trash'}),
])
def test_fixture_that_outlives_the_edit_lease_still_gets_measured(tmp_path, monkeypatch, scenario, measured):
    # Each wall-clock reading advances two seconds. At 40 nodes and 40 saves
    # each fixture loop outlives the lease on its own, however fast the machine is.
    now = [time.time()]

    def tick():
        now[0] += 2
        return now[0]

    clock = SimpleNamespace(time=tick, monotonic=time.monotonic, sleep=time.sleep, perf_counter=time.perf_counter)
    for module in (local_projects, creation_projects, bench):
        monkeypatch.setattr(module, 'time', clock)
    start = now[0]
    result = scenario(tmp_path, commits=40, nodes=40, projects_count=0)
    assert all(isinstance(result[key], float) for key in measured), result
    assert result['nodes'] == 40 and result['commits'] == 40
    assert now[0] - start > 3 * local_projects.LocalProjects.LEASE_SECONDS
