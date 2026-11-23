"""The pre-registered bands decide the next optimization, so they need a test.

A measurement nobody can act on is worse than none: these cases pin the three
start-up bands and the "most of the turn is outside tool calls" note to the
turn's wall clock, which is what the decision was made against.
"""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bench_turn_timing', ROOT / 'scripts/bench_turn_timing.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def turn(turn_seconds, calls):
    return {'summary': {'turnSeconds': turn_seconds}, 'calls': [
        {'id': f'cli:{index}', 'name': 'opendirector', 'status': 'complete',
         'startedAt': 0.0, 'endedAt': spawn + work, 'spawn': spawn, 'work': work}
        for index, (spawn, work) in enumerate(calls)]}


def test_start_up_above_forty_percent_of_the_turn_replaces_the_transport():
    numbers = bench.report([turn(100.0, [(1.2, 0.1)] * 40)])
    assert numbers['spawnShareOfTurn'] == 0.48
    assert 'replace the CLI transport' in bench.verdict(numbers)


def test_start_up_between_twenty_and_forty_percent_runs_both_channels():
    numbers = bench.report([turn(100.0, [(1.2, 0.1)] * 25)])
    assert numbers['spawnShareOfTurn'] == 0.3
    assert 'alongside the CLI' in bench.verdict(numbers)


def test_start_up_below_twenty_percent_keeps_the_cli_transport():
    numbers = bench.report([turn(100.0, [(1.2, 0.1)] * 10)])
    assert numbers['spawnShareOfTurn'] == 0.12
    assert 'not the problem' in bench.verdict(numbers)


def test_a_turn_spent_outside_tool_calls_says_so():
    numbers = bench.report([turn(100.0, [(1.2, 0.1)] * 10)])
    assert numbers['unaccountedShare'] > 0.5
    assert 'outside tool calls' in bench.verdict(numbers)


def test_calls_without_transport_timing_are_counted_but_not_decomposed():
    numbers = bench.report([{'summary': {'turnSeconds': 10.0}, 'calls': [
        {'id': 'deepseek:a', 'startedAt': 0.0, 'endedAt': 2.0}]}])
    assert numbers['calls'] == 1 and numbers['measurableCalls'] == 1
    assert numbers['decomposedCalls'] == 0
    assert numbers['spawnShareOfCalls'] is None


def test_an_empty_or_missing_directory_is_not_an_error(tmp_path):
    assert bench.load(tmp_path) == []
    assert bench.main(['--project', str(tmp_path)]) == 1


def test_the_report_reads_what_a_turn_writes(tmp_path):
    from opendirector.agent import timing

    ledger = {}
    timing.note(ledger, {'type': 'tool', 'id': 'cli:1', 'name': 'read_project',
                         'status': 'running', 'timing': {'spawn': 1.1}})
    timing.note(ledger, {'type': 'tool', 'id': 'cli:1', 'name': 'read_project',
                         'status': 'complete', 'timing': {'spawn': 1.1, 'work': 0.2}})
    timing.write(tmp_path, '00000000-0000-0000-0000-000000000001', ledger, 5.0)
    numbers = bench.report(bench.load(tmp_path))
    assert numbers['calls'] == 1
    assert numbers['decomposedCalls'] == 1
    assert numbers['spawnShareOfTurn'] == 0.22
    assert json.loads(json.dumps(numbers))['turns'] == 1
