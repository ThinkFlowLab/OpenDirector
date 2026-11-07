"""Daily benchmark comparison: fixed #180 scale, notify only past the threshold."""
import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'scripts/nightly/benchmark.json'
SCRIPT = ROOT / 'scripts/nightly/daily_benchmark.py'

spec = importlib.util.spec_from_file_location('daily_benchmark', SCRIPT)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

NOW = datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc)


def config():
    return bench.load_config(CONFIG)


def storage(snapshot=40, open_ms=38, listing=120, read=35, trash=12):
    return {
        'cold-open': {'ok': True, 'data': {'snapshot': snapshot, 'open': open_ms}},
        'catalog': {'ok': True, 'data': {'list_projects_first': listing}},
        'delete': {'ok': True, 'data': {'client_snapshot': read, 'trash': trash}},
    }


def ui(node=14, pan=11, render_ms=900, passed=True):
    return {
        'drag': {'node': {'frameP95': node}, 'pan': {'frameP95': pan}},
        'render': {'passed': passed, 'renderMs': render_ms},
    }


def previous(metrics, recorded_at='2026-11-07T18:00:00Z'):
    return {'version': 1, 'sha': 'prev', 'runId': 9, 'recordedAt': recorded_at, 'metrics': metrics}


def report(storage_results, *, previous_payload=None, sample=None, ui_required=False, ui_error=None):
    return bench.build_report(
        config(), storage_results, sample, previous_payload,
        sha='abc', run_id=7, now=NOW, ui_required=ui_required, ui_error=ui_error)


def test_fixed_scenario_matches_canvas_acceptance_scale():
    loaded = config()
    assert loaded['storage']['cold-open'] == {'commits': 600, 'nodes': 200, 'projects': 0}
    assert loaded['storage']['catalog'] == {'commits': 0, 'nodes': 3, 'projects': 200}
    assert loaded['storage']['delete'] == {'commits': 600, 'nodes': 200, 'projects': 0}
    assert loaded['regressionRatio'] == 1.5
    assert loaded['reference'] == 'baseline-else-previous'
    assert loaded['baseline']['metrics'] == {}


def test_within_threshold_records_yesterday_without_notifying():
    prior = previous({
        'storage.coldOpen.snapshot': 42, 'storage.coldOpen.open': 40,
        'storage.catalog.listFirst': 110, 'storage.delete.clientSnapshot': 36,
        'storage.delete.trash': 13, 'ui.drag.node.frameP95': 15, 'ui.drag.pan.frameP95': 12,
    })
    result = report(storage(), previous_payload=prior, sample=ui())
    assert result['notify'] is False
    assert result['regressions'] == []
    assert result['comparison']['previous']['label'] == 'yesterday'
    assert 'within threshold' in result['summary']
    assert 'baseline unseeded' in result['summary']
    assert '-5%/-5% vs yesterday' in result['summary']
    assert '\n' not in result['summary']
    assert result['samples']['ui']['render']['renderMs'] == 900


def test_recent_rerun_is_labeled_previous_not_yesterday():
    prior = previous({'storage.coldOpen.snapshot': 40}, recorded_at='2026-11-08T12:00:00Z')
    result = report(storage(), previous_payload=prior, sample=ui())
    assert result['comparison']['previous']['label'] == 'previous'
    assert 'vs previous' in result['summary']


def test_regression_uses_baseline_when_seeded_and_still_reports_yesterday():
    loaded = config()
    loaded['baseline']['metrics'] = {'storage.coldOpen.snapshot': 100}
    prior = previous({'storage.coldOpen.snapshot': 390})
    quiet = report(storage(snapshot=120), previous_payload=prior, sample=ui())
    built = bench.build_report(
        loaded, storage(snapshot=400), ui(), prior,
        sha='abc', run_id=7, now=NOW, ui_required=False, ui_error=None)
    assert quiet['notify'] is False
    assert built['notify'] is True
    assert built['regressions'] == ['storage.coldOpen.snapshot']
    assert 'vs yesterday' in built['summary']
    assert 'vs baseline' in built['summary']
    assert built['comparison']['metrics']['storage.coldOpen.snapshot']['reference'] == 'baseline'


def test_ratio_alone_under_min_delta_does_not_notify():
    loaded = config()
    loaded['baseline']['metrics'] = {
        'storage.coldOpen.snapshot': 100, 'storage.coldOpen.open': 100,
        'storage.catalog.listFirst': 100, 'storage.delete.clientSnapshot': 100,
        'storage.delete.trash': 20, 'ui.drag.node.frameP95': 10, 'ui.drag.pan.frameP95': 10,
    }
    # 1.6× snapshot but only +60 ms, under the 100 ms storage floor.
    result = bench.build_report(
        loaded, storage(snapshot=160, open_ms=100, listing=100, read=100, trash=20),
        ui(node=10, pan=10), None,
        sha='abc', run_id=7, now=NOW, ui_required=False, ui_error=None)
    assert result['notify'] is False
    assert result['regressions'] == []


def test_no_previous_and_unseeded_baseline_does_not_notify():
    result = report(storage(), sample=ui())
    assert result['notify'] is False
    assert result['summary'].count('no yesterday') == 1
    assert 'baseline unseeded' in result['summary']
    assert result['comparison']['baselineSeeded'] is False


def test_storage_scenario_failure_notifies_even_without_a_slower_metric():
    broken = storage()
    broken['catalog'] = {'ok': False, 'error': 'disk full'}
    result = report(broken, sample=ui())
    assert result['notify'] is True
    assert 'SUITE catalog' in result['summary']
    assert result['errors'] == [{'scenario': 'catalog', 'message': 'disk full'}]


def test_missing_ui_sample_is_advisory_until_the_lane_requires_it():
    optional = report(storage(), ui_error='perf file missing')
    required = report(storage(), ui_required=True, ui_error='perf file missing')
    assert optional['notify'] is False
    assert 'drag p95 unavailable' in optional['summary']
    assert required['notify'] is True
    assert 'SUITE ui sample missing' in required['summary']


def test_render_probe_failure_is_not_a_benchmark_regression():
    result = report(storage(), sample=ui(passed=False))
    assert result['notify'] is False
    assert result['samples']['ui']['render']['passed'] is False
    assert result['regressions'] == []


def test_incomparable_previous_artifact_is_ignored():
    result = report(storage(), previous_payload={'version': 2, 'metrics': {}}, sample=ui())
    assert result['notify'] is False
    assert result['comparison']['previous']['ignored'] == 'previous artifact version is not comparable'
    assert 'no yesterday' in result['summary']


def test_zero_reference_regresses_only_past_the_absolute_floor():
    prior = previous({'ui.drag.node.frameP95': 0, 'ui.drag.pan.frameP95': 11})
    under = report(storage(), previous_payload=prior, sample=ui(node=40, pan=11))
    over = report(storage(), previous_payload=prior, sample=ui(node=80, pan=11))
    assert under['notify'] is False
    assert over['regressions'] == ['ui.drag.node.frameP95']
    assert over['notify'] is True


def test_storage_bench_emits_the_fields_the_suite_tracks():
    loaded = config()
    tiny = {
        'cold-open': {'commits': 2, 'nodes': 2, 'projects': 0},
        'catalog': {'commits': 0, 'nodes': 2, 'projects': 2},
        'delete': {'commits': 2, 'nodes': 2, 'projects': 0},
    }
    ran = {}
    for metric in loaded['metrics']:
        if metric['source'] != 'storage' or metric['scenario'] in ran:
            continue
        ran[metric['scenario']] = bench.run_scenario(metric['scenario'], tiny[metric['scenario']])
    for metric in loaded['metrics']:
        if metric['source'] != 'storage':
            continue
        result = ran[metric['scenario']]
        assert result['ok'], result
        assert metric['field'] in result['data']
        assert isinstance(result['data'][metric['field']], float)


def test_cli_exits_with_the_notify_bit_and_writes_one_line(tmp_path):
    prior_path = tmp_path / 'previous.json'
    prior_path.write_text(json.dumps(previous({
        'storage.coldOpen.snapshot': 40, 'storage.coldOpen.open': 38,
        'storage.catalog.listFirst': 120, 'storage.delete.clientSnapshot': 35,
        'storage.delete.trash': 12,
    })), encoding='utf-8')
    out = tmp_path / 'daily-benchmark.json'
    quiet = subprocess.run(
        [sys.executable, str(SCRIPT), '--storage', str(_write(tmp_path / 'quiet.json', storage())),
         '--previous', str(prior_path), '--out', str(out), '--sha', 'abc', '--run-id', '7',
         '--now', '2026-11-08T18:00:00Z'],
        check=False, capture_output=True, text=True)
    written = json.loads(out.read_text(encoding='utf-8'))
    assert quiet.returncode == 0
    assert quiet.stdout.strip() == written['summary']
    assert written['notify'] is False
    loud = subprocess.run(
        [sys.executable, str(SCRIPT), '--storage', str(_write(tmp_path / 'loud.json', storage(snapshot=4000))),
         '--previous', str(prior_path), '--out', str(out), '--sha', 'abc', '--run-id', '7',
         '--now', '2026-11-08T18:00:00Z'],
        check=False, capture_output=True, text=True)
    assert loud.returncode == 1
    assert json.loads(out.read_text(encoding='utf-8'))['notify'] is True


def _write(path, payload):
    path.write_text(json.dumps(payload), encoding='utf-8')
    return path
