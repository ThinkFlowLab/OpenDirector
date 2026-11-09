"""Fixed daily benchmark: storage micro-bench plus the nightly UI sample.

Reads ``scripts/nightly/benchmark.json`` and writes one trend document.
Exit 0 when nothing should notify the room. Exit 1 when a tracked metric
regresses past the configured threshold, when the suite itself fails, or when a
required measurement is missing from a sample that otherwise parsed. The
one-line summary is always printed and stored; a within-threshold run with every
required measurement present is not a failure.

UI latency budgets in ``docs/development/ui-performance.md`` are not read
here. Render-probe success stays on the perf-outputs lane.

    python scripts/nightly/daily_benchmark.py --out daily-benchmark.json \\
        --sha "$GITHUB_SHA" --run-id "$GITHUB_RUN_ID" \\
        --perf nightly-perf.json --previous previous/daily-benchmark.json
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "scripts" / "bench_creation_projects.py"
SCENARIOS = ("cold-open", "catalog", "delete")
DRAG_SAMPLE_FIELDS = ("elapsed", "frameP95", "frames", "longTasks", "maxLong")
RENDER_SAMPLE_FIELDS = ("passed", "renderMs", "duration", "frames", "bytes")


def load_config(path):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    if config.get("version") != 1:
        raise ValueError("benchmark config version must be 1")
    if config.get("reference") != "baseline-else-previous":
        raise ValueError("unsupported reference policy")
    ratio = config.get("regressionRatio")
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or ratio <= 1:
        raise ValueError("regressionRatio must be a number greater than 1")
    storage = config.get("storage")
    if not isinstance(storage, dict):
        raise ValueError("storage scenarios are required")
    for scenario in SCENARIOS:
        params = storage.get(scenario)
        if not isinstance(params, dict):
            raise ValueError(f"missing storage scenario {scenario}")
        for key in ("commits", "nodes", "projects"):
            if type(params.get(key)) is not int or params[key] < 0:
                raise ValueError(f"{scenario}.{key} must be a non-negative integer")
    metrics = config.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        raise ValueError("metrics must be a non-empty list")
    seen = set()
    for metric in metrics:
        metric_id = metric.get("id")
        if not isinstance(metric_id, str) or not metric_id or metric_id in seen:
            raise ValueError("metric id must be a unique string")
        seen.add(metric_id)
        if type(metric.get("minDeltaMs")) is not int or metric["minDeltaMs"] < 0:
            raise ValueError(f"{metric_id} minDeltaMs must be a non-negative integer")
        if metric.get("source") == "storage":
            if metric.get("scenario") not in SCENARIOS or not metric.get("field"):
                raise ValueError(f"{metric_id} storage metric is incomplete")
        elif metric.get("source") == "drag":
            if metric.get("kind") not in {"node", "pan"} or not metric.get("field"):
                raise ValueError(f"{metric_id} drag metric is incomplete")
        else:
            raise ValueError(f"{metric_id} source is not storage or drag")
    baseline = config.get("baseline", {}).get("metrics", {})
    if not isinstance(baseline, dict):
        raise ValueError("baseline.metrics must be an object")
    return config


def run_scenario(scenario, params):
    command = [
        sys.executable,
        str(BENCH),
        "--scenario",
        scenario,
        "--commits",
        str(params["commits"]),
        "--nodes",
        str(params["nodes"]),
        "--projects",
        str(params["projects"]),
        "--json",
    ]
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "benchmark failed").strip()
        return {"ok": False, "error": one_line(detail)[-400:]}
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"invalid json: {exc}"}
    if not isinstance(data, dict):
        return {"ok": False, "error": "benchmark json must be an object"}
    return {"ok": True, "data": data}


def run_storage(config):
    return {
        scenario: run_scenario(scenario, config["storage"][scenario])
        for scenario in SCENARIOS
    }


def load_perf(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    drag = {}
    for scenario in payload.get("drag", {}).get("scenarios", []):
        kind = scenario.get("kind")
        if kind in {"node", "pan"}:
            drag[kind] = {
                field: scenario.get(field)
                for field in DRAG_SAMPLE_FIELDS
                if field in scenario
            }
    render = payload.get("render") or {}
    return {
        "drag": drag,
        "render": {
            field: render.get(field)
            for field in RENDER_SAMPLE_FIELDS
            if field in render
        },
    }


def load_previous(path):
    file = Path(path)
    if not file.is_file():
        return None
    try:
        payload = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"ignored": f"unreadable previous artifact: {exc}"}
    if payload.get("version") != 1 or not isinstance(payload.get("metrics"), dict):
        return {"ignored": "previous artifact version is not comparable"}
    return payload


def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def previous_label(previous, now):
    recorded = parse_time(previous.get("recordedAt")) if previous else None
    if recorded is None:
        return "previous"
    hours = (now - recorded).total_seconds() / 3600
    if 12 <= hours <= 36:
        return "yesterday"
    return "previous"


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def change_ratio(current, reference):
    if reference is None or reference == 0:
        return None
    return (current - reference) / reference


def regressed(current, reference, ratio_limit, min_delta):
    if reference is None or current - reference < min_delta:
        return False
    if reference == 0:
        return current > 0
    return current > reference * ratio_limit


def required_metric_ids(config, ui_required):
    """Measurements this lane must produce: storage always, drag when it gates.

    A drag metric stays optional while the UI lane is advisory, so an absent UI
    sample is only a note; once ``--ui-required`` is passed, a sample without
    that frame measurement is incomplete rather than quiet.
    """
    return [metric["id"] for metric in config["metrics"]
            if metric["source"] != "drag" or ui_required]


def metric_value(metric, storage, ui):
    if metric["source"] == "storage":
        scenario = storage.get(metric["scenario"]) or {}
        if not scenario.get("ok"):
            return None
        return number((scenario.get("data") or {}).get(metric["field"]))
    if not ui:
        return None
    return number((ui.get("drag") or {}).get(metric["kind"], {}).get(metric["field"]))


def pct(delta):
    if delta is None:
        return "n/a"
    value = round(delta * 100)
    if value > 0:
        return f"+{value}%"
    return f"{value}%"


def one_line(text):
    return " ".join(str(text).split())


def clause(title, views, previous_label_text, show_baseline, has_previous):
    labels = "/".join(view["label"] for view in views)
    if all(view["value"] is not None for view in views):
        numbers = "/".join(f"{view['value']:.1f}" for view in views) + "ms"
    else:
        numbers = "/".join(
            "FAILED" if view["value"] is None else f"{view['value']:.1f}ms"
            for view in views
        )
    bits = []
    if has_previous:
        bits.append(
            "/".join(pct(view["previousRatio"]) for view in views)
            + f" vs {previous_label_text}"
        )
    if show_baseline and any(view["baseline"] is not None for view in views):
        bits.append(
            "/".join(
                pct(view["baselineRatio"]) if view["baseline"] is not None else "n/a"
                for view in views
            )
            + " vs baseline"
        )
    body = f"{title} {labels} {numbers}"
    if not bits:
        return body
    return f"{body} ({', '.join(bits)})"


def format_summary(config, views, *, has_previous, previous_label_text,
                    show_baseline, suite, regressions, ui_unavailable, ui_required,
                    incomplete):
    cold = config["storage"]["cold-open"]
    catalog = config["storage"]["catalog"]
    prefix = (
        f"{cold['commits']} commits/{cold['nodes']} nodes, "
        f"{catalog['projects']} projects"
    )
    grouped = []
    drag = []
    for view in views:
        if view["source"] == "drag":
            drag.append(view)
            continue
        if not grouped or grouped[-1][0] != view["scenario"]:
            grouped.append((view["scenario"], []))
        grouped[-1][1].append(view)
    parts = [
        clause(name, group, previous_label_text, show_baseline, has_previous)
        for name, group in grouped
    ]
    if drag and any(view["value"] is not None for view in drag):
        parts.append(clause("drag p95", drag, previous_label_text, show_baseline, has_previous))
    else:
        parts.append("drag p95 unavailable")
    if not has_previous:
        parts.append("no yesterday")
    if not show_baseline:
        parts.append("baseline unseeded")
    if suite:
        parts.append("SUITE " + ",".join(suite))
    if ui_required and ui_unavailable:
        parts.append("SUITE ui sample missing")
    if incomplete:
        parts.append("INCOMPLETE " + ",".join(incomplete))
    if regressions:
        parts.append("REGRESSION " + ",".join(regressions))
    elif not suite and not incomplete and not (ui_required and ui_unavailable):
        parts.append("within threshold")
    return one_line(prefix + ": " + "; ".join(parts))


def comparable_previous(previous):
    if not isinstance(previous, dict):
        return None, None
    if previous.get("ignored"):
        return None, str(previous["ignored"])
    if previous.get("version") != 1 or not isinstance(previous.get("metrics"), dict):
        return None, "previous artifact version is not comparable"
    return previous, None


def build_report(config, storage, ui, previous, *, sha, run_id, now, ui_required, ui_error):
    baseline_metrics = config.get("baseline", {}).get("metrics", {})
    comparable, ignored = comparable_previous(previous)
    previous_metrics = comparable.get("metrics", {}) if comparable else {}
    has_previous = bool(previous_metrics)
    label = previous_label(comparable, now) if has_previous else None
    views = []
    metrics = {}
    comparison = {}
    regressions = []
    missing = []
    for metric in config["metrics"]:
        metric_id = metric["id"]
        current = metric_value(metric, storage, ui)
        if current is None:
            missing.append(metric_id)
            views.append({
                "id": metric_id,
                "label": metric["label"],
                "source": metric["source"],
                "scenario": metric.get("scenario"),
                "value": None,
                "previous": None,
                "previousRatio": None,
                "baseline": None,
                "baselineRatio": None,
            })
            continue
        current = round(current, 1)
        metrics[metric_id] = current
        baseline = number(baseline_metrics.get(metric_id))
        prior = number(previous_metrics.get(metric_id)) if has_previous else None
        reference_name = "baseline" if baseline is not None else ("previous" if prior is not None else None)
        reference = baseline if baseline is not None else prior
        regression = regressed(current, reference, config["regressionRatio"], metric["minDeltaMs"])
        if regression:
            regressions.append(metric_id)
        view = {
            "id": metric_id,
            "label": metric["label"],
            "source": metric["source"],
            "scenario": metric.get("scenario"),
            "value": current,
            "previous": prior,
            "previousRatio": change_ratio(current, prior),
            "baseline": baseline,
            "baselineRatio": change_ratio(current, baseline),
        }
        views.append(view)
        comparison[metric_id] = {
            "value": current,
            "previous": prior,
            "previousRatio": view["previousRatio"],
            "baseline": baseline,
            "baselineRatio": view["baselineRatio"],
            "reference": reference_name,
            "regression": regression,
            "minDeltaMs": metric["minDeltaMs"],
        }
    show_baseline = any(view["baseline"] is not None for view in views)
    suite = [scenario for scenario in SCENARIOS if not (storage.get(scenario) or {}).get("ok")]
    ui_unavailable = ui is None
    required = set(required_metric_ids(config, ui_required))
    # A sample that parsed but lost a measurement it was supposed to carry never
    # reached the threshold check, so the run cannot be reported as quiet.
    incomplete = [metric_id for metric_id in missing if metric_id in required]
    summary = format_summary(
        config,
        views,
        has_previous=has_previous,
        previous_label_text=label or "previous",
        show_baseline=show_baseline,
        suite=suite,
        regressions=regressions,
        ui_unavailable=ui_unavailable,
        ui_required=ui_required,
        incomplete=incomplete,
    )
    notify = bool(regressions or suite or incomplete)
    samples = {}
    for scenario in SCENARIOS:
        result = storage.get(scenario) or {"ok": False, "error": "not run"}
        if result.get("ok"):
            samples[scenario] = result.get("data")
        else:
            samples[scenario] = {"error": result.get("error") or "failed"}
    previous_record = {"present": bool(comparable), "label": label}
    if comparable:
        previous_record.update({
            "sha": comparable.get("sha"),
            "runId": comparable.get("runId"),
            "recordedAt": comparable.get("recordedAt"),
        })
    if ignored:
        previous_record["ignored"] = ignored
    return {
        "version": 1,
        "sha": sha,
        "runId": run_id,
        "recordedAt": now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "scenario": config["storage"],
        "regressionRatio": config["regressionRatio"],
        "metrics": metrics,
        "missing": missing,
        "incomplete": incomplete,
        "regressions": regressions,
        "notify": notify,
        "summary": summary,
        "comparison": {
            "previous": previous_record,
            "baselineSeeded": show_baseline,
            "metrics": comparison,
        },
        "samples": {"storage": samples, "ui": ui, "uiError": ui_error},
        "errors": [
            {"scenario": scenario, "message": samples[scenario]["error"]}
            for scenario in SCENARIOS
            if "error" in samples[scenario]
        ],
    }


def failure_report(message, sha, run_id, now):
    summary = one_line(f"SUITE benchmark config: {message}")
    return {
        "version": 1,
        "sha": sha,
        "runId": run_id,
        "recordedAt": now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "metrics": {},
        "missing": [],
        "incomplete": [],
        "regressions": [],
        "notify": True,
        "summary": summary,
        "errors": [{"scenario": "config", "message": one_line(message)}],
    }


def write_report(path, report):
    Path(path).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "scripts/nightly/benchmark.json")
    parser.add_argument("--storage", type=Path, help="Combined scenario results; omit to run the bench")
    parser.add_argument("--perf", type=Path, help="nightly-perf.json from the same run")
    parser.add_argument("--previous", type=Path, help="Previous daily-benchmark.json")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--sha", default="unknown")
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--now", help="ISO time used to label yesterday; default UTC now")
    parser.add_argument("--ui-required", action="store_true")
    args = parser.parse_args(argv)
    now = parse_time(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        now = datetime.now(timezone.utc)
    try:
        config = load_config(args.config)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        report = failure_report(str(exc), args.sha, args.run_id, now)
        write_report(args.out, report)
        print(report["summary"])
        return 1
    if args.storage:
        try:
            storage = json.loads(args.storage.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            report = failure_report(f"storage results: {exc}", args.sha, args.run_id, now)
            write_report(args.out, report)
            print(report["summary"])
            return 1
    else:
        storage = run_storage(config)
    ui = None
    ui_error = None
    if args.perf:
        if not args.perf.is_file():
            ui_error = "perf file missing"
        else:
            try:
                ui = load_perf(args.perf)
            except (OSError, json.JSONDecodeError) as exc:
                ui_error = one_line(exc)
    previous = load_previous(args.previous) if args.previous else None
    report = build_report(
        config,
        storage,
        ui,
        previous,
        sha=args.sha,
        run_id=args.run_id,
        now=now,
        ui_required=args.ui_required,
        ui_error=ui_error,
    )
    write_report(args.out, report)
    print(report["summary"])
    return 1 if report["notify"] else 0


if __name__ == "__main__":
    sys.exit(main())
