"""Report where one agent run spends its time.

Every turn writes `agent-runs/timing/<turn>.json` with raw numbers only, so the
percentages below never live in the hot path. Run this after a task to decide
which cost dominates: start-up of the business CLI, the command itself, or the
part of a tool call that the runtime reports but cannot decompose.

    python3 scripts/bench_turn_timing.py --project ~/path/to/project [--json]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys


def load(project):
    directory = Path(project).expanduser() / 'agent-runs' / 'timing'
    turns = []
    for path in sorted(directory.glob('*.json')) if directory.is_dir() else []:
        try:
            turns.append(json.loads(path.read_text(encoding='utf-8')))
        except (OSError, ValueError):
            continue
    return turns


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def report(turns):
    calls = [call for turn in turns for call in turn.get('calls', [])]
    durations = [call['endedAt'] - call['startedAt'] for call in calls if 'endedAt' in call]
    spawns = [call['spawn'] for call in calls if isinstance(call.get('spawn'), (int, float))]
    works = [call['work'] for call in calls if isinstance(call.get('work'), (int, float))]
    turn_seconds = sum(turn['summary'].get('turnSeconds') or 0 for turn in turns)
    measured = sum(durations)
    return {
        'turns': len(turns),
        'turnSeconds': round(turn_seconds, 2),
        'calls': len(calls),
        'measurableCalls': len(durations),
        'decomposedCalls': len(spawns),
        'callSeconds': round(measured, 2),
        'callShare': round(measured / turn_seconds, 3) if turn_seconds else None,
        'spawnSeconds': round(sum(spawns), 2),
        # A runtime that cannot see start-up is unknown, not zero: reporting 0
        # would read as "start-up is free" and settle the decision wrongly.
        'spawnShareOfCalls': round(sum(spawns) / measured, 3) if spawns and measured else None,
        'spawnShareOfTurn': round(sum(spawns) / turn_seconds, 3) if spawns and turn_seconds else None,
        'workSeconds': round(sum(works), 2),
        'p50Seconds': percentile(durations, 0.5),
        'p90Seconds': percentile(durations, 0.9),
        'unaccountedSeconds': round(turn_seconds - measured, 2),
        'unaccountedShare': round((turn_seconds - measured) / turn_seconds, 3) if turn_seconds else None,
    }


def verdict(numbers):
    """Name the dominant cost, so the next change has one target.

    The bands were pre-registered from the turn's wall clock, not from the call
    count: batching already lowered the count, and a cheap call repeated many
    times is not the same problem as an expensive one repeated a few times.
    """
    share = numbers['spawnShareOfTurn']
    if share is None or not numbers['turnSeconds']:
        return 'no turn recorded launch timing yet, so start-up cannot be ruled in or out'
    if share > 0.4:
        decision = 'start-up dominates the turn: replace the CLI transport (R1)'
    elif share > 0.2:
        decision = 'start-up matters but does not dominate: run a native channel alongside the CLI'
    else:
        decision = 'start-up is not the problem: keep the CLI transport and cut calls instead'
    if (numbers['unaccountedShare'] or 0) > 0.5:
        decision += '; most of the turn is outside tool calls, so fewer turns and probes pay first'
    elif (numbers['spawnShareOfCalls'] or 0) > 0.4:
        decision += '; start-up still dominates each call, so batching pays inside the channel too'
    return decision


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True, help='Project directory holding agent-runs/timing.')
    parser.add_argument('--json', action='store_true', help='Print the numbers as JSON.')
    options = parser.parse_args(argv)
    turns = load(options.project)
    numbers = report(turns)
    numbers['verdict'] = verdict(numbers)
    if options.json:
        print(json.dumps(numbers, ensure_ascii=False, indent=2))
    else:
        for name, value in numbers.items():
            print(f'{name:24} {value}')
    return 0 if turns else 1


if __name__ == '__main__':
    sys.exit(main())
