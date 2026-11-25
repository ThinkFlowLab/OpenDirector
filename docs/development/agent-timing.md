# Agent turn timing

Each agent turn records where its time went. Optimizing the tool channel or the model loop without that split is guesswork, and the split did not exist: the trace carried events but no timestamps.

## What is recorded

- The business CLI takes its start timestamp before it imports anything, and reports it on its first request (`timing.startedAt`, `timing.firstCall`). This is the only way to see interpreter start-up and imports: the host only sees the request that arrives after them. A process's later requests report no start-up, so a command that waits in a loop is charged that cost once rather than once per poll.
- The transport turns that into `spawn` (start-up) and `work` (the command itself) on the tool events it already emits. A runtime whose tool calls never reach that transport reports neither, and the ledger then keeps one call's wall time alone.
- The API layer folds tool events into one entry per call, keyed by call identity, and writes `agent-runs/timing/<turn>.json` once when the turn ends.

The ledger keeps the per-call numbers and one aggregate per turn. Shares across turns stay offline, so a broken measurement can at worst lose one file; it can never fail a turn.

Raw numbers deliberately do not go into conversation history: a turn with hundreds of tool events already fills the 64 KB the CLI reads back, and two timestamps per event would make that worse.

## Reading it

```sh
python3 scripts/bench_turn_timing.py --project <project directory> [--json]
```

The report prints, per project: the turn's wall clock, call time and its share, start-up and its share of the turn and of calls, the unaccounted remainder (model thinking plus orchestration), and the P50 and P90 of one call.

Call time is the union of the calls' wall-clock intervals, each stretched to include the start-up it paid for. Calls nest — a Bash call that runs the CLI contains the CLI call — so adding durations up would count the inner seconds twice and report more tool time than the turn had. `callSecondsSum` and `overlapSeconds` show that double count.

## Decision bands

Shares use the turn's wall clock, not the call count: batching already lowered the count, and a cheap call repeated many times is a different problem from an expensive one repeated a few times.

| Start-up share of the turn | Decision |
| --- | --- |
| > 40% | Replace the CLI transport with a native channel. |
| 20–40% | Run a native channel alongside the CLI. |
| < 20% | Keep the transport; cut calls and probes instead. |

When more than half the turn is outside tool calls, fewer turns and fewer discovery probes pay before any transport change does. A runtime that reports no start-up at all leaves the question open rather than answered: unknown is not zero.

Choosing a band needs launch timing on every call. A call that never reached the transport, such as a `--help` probe, still started a process whose start-up nobody saw, so when `startupCoverage` is below 1 the report calls the decision inconclusive instead of naming a band.

These bands are advisory and stay out of CI. Timing assertions would inherit the flakiness of network, machine load and provider latency; recorded evidence belongs in reports, not in gates.
