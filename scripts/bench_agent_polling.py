"""Measure the agent's per-turn polling, discovery and project-read cost.

The agent waits for generation through the CLI. This compares the cost of the
per-job wait loop with the batched `job.status` query, the full project read with
`project show --summary`, and per-command `--help` discovery with the single
`capabilities` digest. The synthetic project has the same shape as the trace in
issue #449 (many canvas items, a long commit history, several unfinished jobs):

    python scripts/bench_agent_polling.py
    python scripts/bench_agent_polling.py --jobs 14 --ticks 60 --commits 600 --nodes 200 --json
"""

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

SOURCE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SOURCE / "packages/core/src"), str(SOURCE / "apps/api/src")]

from opendirector.application.creation_canvas import CreationCanvas  # noqa: E402
from pydantic import TypeAdapter  # noqa: E402
from opendirector.domain.creation.commands import Query, parse_command  # noqa: E402
from opendirector.domain.creation.generation import ImageGenerationSpec, InputSnapshot, Job  # noqa: E402
from opendirector.domain.creation.models import ModelSnapshot  # noqa: E402
from opendirector.domain.creation.project import ProjectSnapshot  # noqa: E402
from opendirector.infrastructure.creation_projects import CreationProjects  # noqa: E402
from opendirector.infrastructure.local_projects import LocalProjects  # noqa: E402
from opendirector.wiring import configure_runtime  # noqa: E402

sys.path.insert(0, str(SOURCE / "scripts"))
from bench_creation_projects import add_saves, create_project  # noqa: E402


def command(kind, project_id, payload, versions=()):
    return parse_command({"type": kind, "projectId": project_id, "commandId": uuid4(),
                          "payload": payload, "expectedVersions": list(versions)})


def seed_jobs(projects, project_id, session, count):
    snapshot = projects.snapshot(project_id)
    model_id, spec_id = uuid4(), uuid4()
    spec = ImageGenerationSpec(id=spec_id, projectId=project_id, kind="image", purpose="generation",
                               modelConfigId=model_id, prompt="A mountain")
    model = ModelSnapshot(modelConfigId=model_id, kind="image", modelId="demo", url="https://model.test/v1",
                          protocol="openai", connectionType="api")
    inputs = InputSnapshot(spec=spec, model=model)
    jobs = [Job(id=uuid4(), projectId=project_id, inputSnapshot=inputs, inputFingerprint=inputs.fingerprint(),
                execution=dict(kind="image", size="2K")) for _ in range(count)]
    seed = command("generationSpec.create", project_id, {"spec": spec})

    def transform(before):
        data = before.model_dump()
        data["generationSpecs"] = [spec]
        data["jobs"] = jobs
        return ProjectSnapshot.model_validate(data)
    projects.commit(seed, transform, session=session)
    return [job.id for job in jobs]


def timed(operation):
    start = time.perf_counter()
    value = operation()
    return (time.perf_counter() - start) * 1000, value


def measure_polling(projects, canvas, project_id, job_ids, ticks):
    reads = [0]
    snapshot = projects.snapshot

    def counted(identity):
        reads[0] += 1
        return snapshot(identity)
    projects.snapshot = counted

    loop = asyncio.new_event_loop()
    adapter = TypeAdapter(Query)

    def per_job():
        for identity in job_ids:
            loop.run_until_complete(canvas.query(adapter.validate_python(
                dict(type="job.get", projectId=project_id, queryId=uuid4(), objectId=str(identity)))))
        return None

    per_job_ms, _ = timed(per_job)
    per_job_reads = reads[0] / len(job_ids)
    reads[0] = 0
    batch_ms, _ = timed(lambda: asyncio.run(canvas.wait_jobs(project_id, tuple(job_ids), 0, "all")))
    batch_reads = reads[0]
    projects.snapshot = snapshot
    return {"ticks": ticks, "jobs": len(job_ids),
            "perJobQueryMs": round(per_job_ms / len(job_ids), 3),
            "perJobSnapshotReads": per_job_reads,
            "batchedQueryMs": round(batch_ms, 3), "batchedSnapshotReads": batch_reads,
            "baselineTickMs": round(per_job_ms, 3), "batchedTickMs": round(batch_ms, 3),
            "baselineQueriesPerWait": len(job_ids) * ticks, "batchedQueriesPerWait": ticks}


def measure_reads(projects, project_id):
    from opendirector.cli import summarize
    full = projects.snapshot(project_id).model_dump(mode="json")
    full_bytes = len(json.dumps(full, ensure_ascii=False).encode())
    summary = summarize(full)
    summary_bytes = len(json.dumps(summary, ensure_ascii=False).encode())
    return {"fullBytes": full_bytes, "summaryBytes": summary_bytes,
            "ratio": round(summary_bytes / full_bytes, 3), "truncated": full_bytes > 65536}


def measure_discovery():
    from typer.testing import CliRunner
    from opendirector import cli
    runner = CliRunner()
    per_command = 0
    kinds = sorted(cli.COMMANDS)
    for kind in kinds:
        namespace, action = kind.split(".", 1)
        result = runner.invoke(cli.app, [cli.kebab(namespace), cli.kebab(action), "--help"])
        per_command += len(result.output.encode())
    root = len(runner.invoke(cli.app, ["--help"]).output.encode())
    digest = len(runner.invoke(cli.app, ["capabilities", "--compact"]).output.encode())
    verbose = len(runner.invoke(cli.app, ["capabilities"]).output.encode())
    return {"commands": len(kinds), "rootHelpBytes": root, "perCommandHelpBytes": per_command,
            "naiveDiscoveryBytes": root + per_command, "capabilitiesBytes": digest,
            "capabilitiesVerboseBytes": verbose}


def main():
    configure_runtime()
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=int, default=14)
    parser.add_argument("--ticks", type=int, default=60)
    parser.add_argument("--nodes", type=int, default=200)
    parser.add_argument("--commits", type=int, default=600)
    parser.add_argument("--json", action="store_true")
    options = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="bench-agent-polling-"))
    result = {"jobs": options.jobs, "ticks": options.ticks}
    try:
        projects = CreationProjects(LocalProjects(root))
        project_id, session = create_project(projects, "polling", options.nodes)
        add_saves(projects, project_id, session, options.commits, options.nodes)
        canvas = CreationCanvas(projects)
        job_ids = seed_jobs(projects, project_id, session, options.jobs)
        result["polling"] = measure_polling(projects, canvas, project_id, job_ids, options.ticks)
        result["projectRead"] = measure_reads(projects, project_id)
        result["discovery"] = measure_discovery()
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print(json.dumps(result, ensure_ascii=False, indent=2) if not options.json else json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
