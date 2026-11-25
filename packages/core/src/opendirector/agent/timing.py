"""Turn-scoped measurement of one agent run.

The turn's time goes into native model thinking, tool calls, and the project
synchronization each tool call triggers. Optimizing any of them needs their
share of the turn, which nothing currently records.

The ledger is written once per turn under `agent-runs/`, beside the other
runtime state, rather than into conversation history: a turn with ~950 tool
events already fills the 64 KB the CLI reads back, and adding two timestamps
per event would make that worse. The ledger keeps the per-call numbers and one
aggregate per turn; shares across turns belong to offline analysis, so a broken
measurement can at most lose one file and never a turn.
"""
from __future__ import annotations

import json
from pathlib import Path
import time

TERMINAL = frozenset({'complete', 'failed', 'interrupted'})


def note(ledger, event):
    """Fold one tool event into the turn's ledger.

    The transport reports how much of a call was CLI start-up (`spawn`) and how
    much was the command itself (`work`); a runtime that only sees tool events
    reports neither, and the ledger then keeps the call's wall time alone.
    """
    key = event.get('id')
    if not isinstance(key, str):
        return
    now = time.monotonic()
    entry = ledger.get(key)
    if entry is None:
        entry = ledger[key] = {'id': key, 'name': event.get('name'), 'startedAt': now}
    entry['status'] = event.get('status') or entry.get('status', 'running')
    timing = event.get('timing')
    if isinstance(timing, dict):
        entry.update({name: timing[name] for name in ('spawn', 'work')
                      if isinstance(timing.get(name), (int, float))})
    if entry['status'] in TERMINAL:
        entry['endedAt'] = now


def _percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def summary(ledger, turn_seconds=None):
    """Aggregate the ledger into the numbers a comparison needs."""
    durations = [entry['endedAt'] - entry['startedAt'] for entry in ledger.values() if 'endedAt' in entry]
    spawns = [entry['spawn'] for entry in ledger.values() if 'spawn' in entry]
    works = [entry['work'] for entry in ledger.values() if 'work' in entry]
    return {'calls': len(ledger), 'measured': len(durations),
            'turnSeconds': turn_seconds, 'callSeconds': round(sum(durations), 3),
            'spawnSeconds': round(sum(spawns), 3), 'workSeconds': round(sum(works), 3),
            'decomposed': len(spawns),
            'p50Seconds': _percentile(durations, 0.5), 'p90Seconds': _percentile(durations, 0.9)}


def write(directory, turn_id, ledger, turn_seconds):
    """Persist the turn's raw numbers, never at the cost of the turn itself."""
    if not ledger:
        return None
    path = Path(directory) / 'agent-runs' / 'timing' / f'{turn_id}.json'
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'summary': summary(ledger, turn_seconds),
                                    'calls': list(ledger.values())}, ensure_ascii=False), encoding='utf-8')
        return path
    except OSError:
        return None
