"""Reproducible timing for the creation-project storage paths behind the canvas UI.

The canvas opening / switching / deleting experiences are dominated by three
repository operations:

* ``list_projects`` - what the workspace calls before it can open a canvas and
  whenever the project selector opens;
* ``snapshot`` / ``open`` - the first read after a process start (empty caches);
* ``execute(project.trash)`` - removing a canvas.

Run against synthetic data so the numbers are comparable between revisions:

    python scripts/bench_creation_projects.py --scenario cold-open --commits 600 --nodes 200
    python scripts/bench_creation_projects.py --scenario catalog --projects 200
    python scripts/bench_creation_projects.py --scenario delete --commits 600 --nodes 200

Each scenario prints milliseconds; ``--json`` prints one machine-readable object.
The synthetic project is built once per run in a temporary directory and removed
afterwards, so nothing under the repository or the user's workspace is touched.
"""

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

SOURCE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SOURCE / "packages/core/src"), str(SOURCE / "apps/api/src")]

from opendirector.domain.creation.commands import parse_command  # noqa: E402
from opendirector.infrastructure.creation_projects import CreationProjects  # noqa: E402
from opendirector.infrastructure.local_projects import LocalProjects  # noqa: E402


def command(kind, project_id, payload, versions=()):
    return parse_command(
        {
            "type": kind,
            "projectId": project_id,
            "commandId": uuid4(),
            "payload": payload,
            "expectedVersions": list(versions),
        }
    )


def timed(operation):
    start = time.perf_counter()
    value = operation()
    return (time.perf_counter() - start) * 1000, value


def create_project(projects, name, node_count):
    project_id = uuid4()
    projects.execute(command("project.create", project_id, {"name": name}))
    session = str(uuid4())
    projects.open(project_id, session)
    projects.execute(
        command("asset.writeText", project_id, {"name": "notes.md", "text": "hello"}),
        session=session,
    )
    asset = projects.snapshot(project_id).assets[0]
    for index in range(node_count):
        projects.execute(
            command(
                "canvas.show",
                project_id,
                {
                    "item": {
                        "id": str(uuid4()),
                        "projectId": str(project_id),
                        "kind": "text",
                        "title": f"node {index}",
                        "position": {"x": index * 360, "y": 0},
                        "binding": {
                            "role": "material",
                            "objectRef": {
                                "assetId": str(asset.id),
                                "revision": asset.revision,
                                "fingerprint": asset.fingerprint,
                                "kind": asset.kind,
                            },
                        },
                    }
                },
            ),
            session=session,
        )
    return project_id, session


def add_saves(projects, project_id, session, commits, nodes):
    """Autosave-like commits: each one carries the whole snapshot."""
    revisions = {
        item.id: item.revision for item in projects.snapshot(project_id).canvasItems
    }
    item_ids = list(revisions)[:nodes]
    for index in range(commits):
        item_id = item_ids[index % len(item_ids)]
        projects.execute(
            command(
                "canvas.move",
                project_id,
                {
                    "items": [
                        {
                            "itemId": str(item_id),
                            "position": {"x": index + 1, "y": index},
                        }
                    ]
                },
                [
                    {
                        "objectType": "canvas_item",
                        "id": str(item_id),
                        "revision": revisions[item_id],
                    }
                ],
            ),
            session=session,
        )
        revisions[item_id] += 1


def restarted(root):
    """A new process: empty in-memory caches, same files on disk."""
    return CreationProjects(LocalProjects(Path(root)))


def scenario_cold_open(root, commits, nodes, projects_count):
    projects = CreationProjects(LocalProjects(Path(root)))
    project_id, session = create_project(projects, "Bench", nodes)
    add_saves(projects, project_id, session, commits, nodes)
    for index in range(projects_count):
        other, other_session = create_project(projects, f"Project {index:02d}", 3)
        projects.local.release(other_session)
    del projects

    cold = restarted(root)
    result = {}
    result["list_projects"], listing = timed(cold.list_projects)
    result["snapshot"], snapshot = timed(lambda: cold.snapshot(project_id))
    result["open"], opened = timed(lambda: cold.open(project_id, session))
    result["snapshot_after_open"], _ = timed(lambda: cold.snapshot(project_id))
    result["snapshot_bytes"] = len(opened.model_dump_json())
    result["projects"] = len(listing["projects"])
    result["commits"] = commits
    result["nodes"] = len(opened.canvasItems)
    return result


def scenario_catalog(root, commits, nodes, projects_count):
    projects = CreationProjects(LocalProjects(Path(root)))
    project_id, _ = create_project(projects, "Bench", nodes)
    # Extra projects stay small: this scenario isolates per-project listing cost,
    # so building them must not dominate the fixture setup.
    for index in range(projects_count):
        other, other_session = create_project(projects, f"Project {index:02d}", 3)
        projects.local.release(other_session)
    del projects

    cold = restarted(root)
    result = {}
    for label in ("first", "second"):
        result[f"list_projects_{label}"], listing = timed(cold.list_projects)
    result["projects"] = len(listing["projects"])
    result["nodes"] = nodes
    return result


def scenario_delete(root, commits, nodes, projects_count):
    projects = CreationProjects(LocalProjects(Path(root)))
    create_project(projects, "Keep", nodes)
    victim, victim_session = create_project(projects, "Victim", nodes)
    add_saves(projects, victim, victim_session, commits, nodes)
    projects.local.release(victim_session)
    snapshot = projects.snapshot(victim)
    del projects

    cold = restarted(root)
    result = {}
    # The client reads the project before deleting so it can send a version.
    result["client_snapshot"], current = timed(lambda: cold.snapshot(victim))
    result["trash"], _ = timed(
        lambda: cold.execute(
            command(
                "project.trash",
                victim,
                {},
                [
                    {
                        "objectType": "project",
                        "id": str(current.project.id),
                        "revision": current.project.revision,
                    }
                ],
            )
        )
    )
    result["commits"] = commits
    result["nodes"] = nodes
    assert snapshot.project.id == victim
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario", choices=["cold-open", "catalog", "delete"], default="cold-open"
    )
    parser.add_argument("--commits", type=int, default=400)
    parser.add_argument("--nodes", type=int, default=100)
    parser.add_argument("--projects", type=int, default=0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = tempfile.mkdtemp(prefix="opendirector-bench-")
    try:
        if args.scenario == "cold-open":
            result = scenario_cold_open(root, args.commits, args.nodes, args.projects)
        elif args.scenario == "catalog":
            result = scenario_catalog(root, args.commits, args.nodes, args.projects)
        else:
            result = scenario_delete(root, args.commits, args.nodes, args.projects)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    if args.json:
        print(json.dumps({"scenario": args.scenario, **result}, ensure_ascii=False))
        return
    print(f"scenario {args.scenario}: " + ", ".join(
        f"{key}={value}" if isinstance(value, int) and key not in {"snapshot_bytes"}
        else f"{key}={value:.1f} ms" if isinstance(value, float)
        else f"{key}={value}"
        for key, value in result.items()
    ))


if __name__ == "__main__":
    main()
