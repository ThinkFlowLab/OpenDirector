"""Command-line access to OpenDirector's shared project services."""
from contextlib import redirect_stdout
from enum import Enum
from hashlib import sha256
import inspect
import json
import os
from pathlib import Path
import re
import socket
import shlex
import sys
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID, uuid4, uuid5

import httpx
from pydantic import ValidationError
import typer
from typer._click.exceptions import UsageError

from opendirector.agent.tools import COMMANDS, command_help
from opendirector.domain.creation.commands import COMMAND_MODELS, command_fingerprint, parse_command
from opendirector.domain.projects import ProjectError
from opendirector.domain.timeline_errors import timeline_error, timeline_error_message

app = typer.Typer(no_args_is_help=True, help="Start OpenDirector and create or edit projects.",
    epilog="Run opendirector COMMAND --help for subcommands and usage. "
           "Place --project, --url and other global options before the command.")
GROUP_HELP = {
    "project": "List, inspect, create, rename, trash or restore projects.",
    "model": "Inspect available model configurations and input capabilities.",
    "voice": "List, create or delete voices on a configured speech service.",
    "asset": "Import files, write text and manage registered project assets.",
    "canvas": "Display, arrange, hide and configure canvas items.",
    "video": "Create video generation nodes with model settings and references.",
    "job": "Inspect, wait for, cancel or recover generation jobs.",
    "artifact": "Register files from the active agent execution directory.",
    "generation-spec": "Create, edit and restore generation settings and prompts.",
    "reference": "Add, update, restore or remove generation input references.",
    "generation": "Submit a configured generation task.",
    "result": "Select a generated result for adoption.",
    "editor": "Create and save editable media documents.",
    "timeline": "Discover resources for editable timelines.",
    "history": "Undo or redo reversible project operations.",
    "creation": "Apply multiple project operations atomically.",
}
groups: dict[str, typer.Typer] = {}


def kebab(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).replace("_", "-").lower()


def group(name: str) -> typer.Typer:
    if name not in groups:
        groups[name] = typer.Typer(no_args_is_help=True, help=GROUP_HELP[name])
        app.add_typer(groups[name], name=name)
    return groups[name]


@group("timeline").command("default-font", help="Find the bundled timeline font without opening a project.")
def timeline_default_font():
    from opendirector.installation import default_timeline_font
    path = default_timeline_font()
    try:
        manifest = json.loads((path.parent / "manifest.json").read_text(encoding="utf-8"))
        fingerprint = "sha256:" + sha256(path.read_bytes()).hexdigest()
        if fingerprint != manifest["fingerprint"]:
            raise timeline_error('timeline_bundled_font_fingerprint', 409)
    except (OSError, ValueError, KeyError):
        raise timeline_error('timeline_bundled_font_unavailable', 409) from None
    emit(dict(path=str(path), version=manifest["version"], fingerprint=fingerprint))


@group("timeline").command("export", help="Export an exact saved revision as a portable editable .timeline.zip.")
def timeline_export(ctx: typer.Context, editor_id: Annotated[UUID, typer.Option()],
                    revision: Annotated[int, typer.Option(min=1)], output: Annotated[Path, typer.Option()]):
    client = ctx.obj
    client.command = ctx.command_path
    if client.live:
        emit(client.call("timeline_package_export", dict(editorId=str(editor_id), revision=revision, path=str(output))))
        return
    with client.http.stream("GET", client.path(f"/timelines/{editor_id}/package"), params={"revision": revision}) as response:
        if not response.is_success:
            response.read()
            raise client.response_error(response)
        # Exclusive creation keeps a failed download from overwriting a user's file.
        try:
            with output.open("xb") as stream:
                for chunk in response.iter_bytes(): stream.write(chunk)
        except BaseException:
            # An existing destination is never ours to remove.
            if not isinstance(sys.exc_info()[1], FileExistsError): output.unlink(missing_ok=True)
            raise
    emit(dict(path=str(output), editorId=str(editor_id), revision=revision))


@group("timeline").command("import", help="Import an editable bundle; default creates a new timeline.")
def timeline_import(ctx: typer.Context, file: Path, operation_id: Annotated[UUID, typer.Option()],
                    replace_editor: Annotated[UUID | None, typer.Option()] = None,
                    expected_revision: Annotated[int | None, typer.Option(min=1)] = None):
    from opendirector.domain.creation.timeline_packages import TimelinePackageImportRequest
    from opendirector.infrastructure.creation_files import file_identity
    client = ctx.obj
    client.command = ctx.command_path
    fingerprint, _ = file_identity(file)
    arguments = dict(operationId=str(operation_id), archiveFingerprint=fingerprint,
        replaceEditorId=str(replace_editor) if replace_editor else None, expectedRevision=expected_revision)
    handle = uuid5(operation_id, "archive-upload")
    request = TimelinePackageImportRequest.model_validate({**arguments, 'uploadHandle': handle})
    if client.live:
        value = client.call("timeline_package_import", {**arguments, 'path': str(file)}, identity=operation_id)
    else:
        client.open()
        try:
            client.request("GET", client.path(f"/timeline-package-imports/{operation_id}"))
            existing = True
        except ProjectError as error:
            if error.status != 404: raise
            existing = False
        if not existing:
            with file.open('rb') as stream:
                client.request("PUT", client.path(f"/uploads/{handle}"), content=stream,
                    headers={"X-Asset-Name": quote(file.name, safe=''), "X-Asset-Kind": "file"})
        value = client.request("POST", client.path("/timeline-package-imports"), json=request.model_dump(mode='json'))
    emit(value)
    if value['status'] != 'applied': raise typer.Exit(1)


class Client:
    def __init__(self, project, url, session, operation_id):
        self.project = project
        self.command = "opendirector"
        self.session = str(session or uuid4())
        self.operation_id = operation_id
        # Groups related gateway calls (each poll of one job wait) into one
        # assistant activity instead of one activity per call.
        self.activity = None
        self.gateway = dict(os.environ)
        self.live = bool(self.gateway.get("OPENDIRECTOR_AGENT_SOCKET") or self.gateway.get("OPENDIRECTOR_AGENT_HOST"))
        self.opened = False
        self.owns_session = session is None
        self.http = httpx.Client(base_url=url, trust_env=False, timeout=120,
            headers={"X-OpenDirector-Request": "1", "X-OpenDirector-Session": self.session,
                     "Accept-Language": os.environ.get('OPENDIRECTOR_LANGUAGE', 'en-US')})

    @staticmethod
    def response_error(response):
        try:
            value = response.json()
        except ValueError:
            value = None
        if isinstance(value, dict) and isinstance(value.get('detail'), str):
            code = value.get('code')
            return ProjectError(value['detail'], response.status_code, code=code if isinstance(code, str) else None)
        return ProjectError(response.text, response.status_code)

    def request(self, method, path, **kwargs):
        response = self.http.request(method, path, **kwargs)
        if not response.is_success:
            raise self.response_error(response)
        return response.json()

    def path(self, suffix=""):
        if self.project is None:
            raise ProjectError("Select a project with --project UUID.")
        return f"/api/creation/projects/{self.project}{suffix}"

    def call(self, name, arguments, *, identity=None):
        if not self.live:
            raise ProjectError("This operation requires an active agent execution context.")
        endpoint = self.gateway.get("OPENDIRECTOR_AGENT_HOST")
        connection = (socket.create_connection((endpoint, int(self.gateway["OPENDIRECTOR_AGENT_PORT"])), timeout=15)
                      if endpoint else socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
        with connection:
            connection.settimeout(120)
            if not endpoint:
                connection.connect(self.gateway["OPENDIRECTOR_AGENT_SOCKET"])
            connection.sendall((json.dumps({
                "id": str(identity or uuid4()), "cliCommand": self.command, "projectId": str(self.project) if self.project else None, "name": name, "arguments": arguments,
                **({"activity": self.activity} if self.activity else {}),
            }) + "\n").encode())
            with connection.makefile("rb") as reader:
                response = json.loads(reader.readline(64 * 1024 * 1024))
        if response.get("error"):
            raise ProjectError(response["error"], code=response.get('code'))
        return response["value"]

    def models(self):
        return (self.call("read_project", {})["models"] if self.live else
                self.request("GET", "/api/model-configs"))

    def snapshot(self):
        return (self.call("read_project", {})["project"] if self.live else
                self.request("GET", self.path()))

    def open(self):
        if not self.live and not self.opened:
            self.request("POST", self.path("/open"))
            self.opened = True

    def execute(self, kind, payload, versions=(), preview=None, *, identity=None):
        operation = identity or self.operation_id or uuid4()
        arguments = dict(type=kind, payload=payload, expectedVersions=list(versions), expectedPreview=preview)
        if self.live:
            value = self.call("execute_command", arguments, identity=operation)
        else:
            command = parse_command({**arguments, "commandId": operation, "projectId": self.project})
            if kind not in {'project.create', 'project.rename', 'project.trash', 'project.restore'}:
                self.open()
            # An accepted project.trash removes the directory and stores no
            # receipt, so repeating it (including with the same --operation-id)
            # is a 404. That 404 is reported here. The workspace maps it to
            # success only because the project it already listed is gone; a CLI
            # caller can pass a wrong id, and there is no receipt to replay.
            value = self.request("POST", self.path("/commands"), json=command.model_dump(mode="json"))
        if value.get("status") == "rejected":
            emit(value)
            raise typer.Exit(1)
        if value.get("status") == "accepted" and value.get("jobIds"):
            value = {**value, "next": {
                "description": "Wait for each accepted job to finish. On timeout, run the same wait command again.",
                "commands": [shlex.join(["opendirector", "--url", str(self.http.base_url).rstrip("/"),
                    "--project", value["projectId"], "job", "wait", job_id, "--timeout", "60"])
                    for job_id in value["jobIds"]],
            }}
        canvas_versions = {item["id"]: item["revision"] for item in value.get("changed", [])
                           if item["objectType"] == "canvas_item"}
        if kind.startswith("canvas."):
            for version in versions:
                if version["objectType"] == "canvas_item":
                    canvas_versions.setdefault(version["id"], version["revision"])
            canvas_item = payload.get("item")
            if canvas_item is not None:
                canvas_versions.setdefault(canvas_item["id"], canvas_item.get("revision", 1))
        if canvas_versions:
            value = {**value, "canvasItems": []}
            try:
                for item_id, revision in canvas_versions.items():
                    item = self.query("object.get", objectId=item_id, revision=revision)
                    value["canvasItems"].append({
                        **{field: item[field] for field in
                           ("id", "kind", "revision", "parentId", "position", "width", "height", "visible")},
                        "coordinateSpace": "canvas" if item["parentId"] is None else "parent",
                    })
            except (ProjectError, OSError, httpx.HTTPError) as error:
                value["geometryReadError"] = str(error)
        return value

    def query(self, kind, **arguments):
        result = (self.call("query", {"type": kind, **arguments}) if self.live else
            self.request("POST", self.path("/queries"),
                json={"type": kind, "queryId": str(uuid4()), "projectId": str(self.project), **arguments}))
        if kind == "job.get" and result.get("status") == "succeeded" and result.get("asset"):
            snapshot = self.snapshot()
            asset_id = result["asset"]["assetId"]
            results = [value for value in snapshot["results"] if value["asset"]["assetId"] == asset_id]
            adopted_specs = {spec["id"] for spec in snapshot["generationSpecs"]
                if any(value["id"] == spec.get("currentResultId") for value in results)}
            items = [item for item in snapshot["canvasItems"] if
                (item["binding"]["role"] == "generation" and item["binding"]["objectRef"]["id"] in adopted_specs
                 and not item["binding"].get("materialOverride")) or
                (item["binding"]["role"] == "material" and item["binding"]["objectRef"]["assetId"] == asset_id)]
            result = {**result, "delivery": {"registered": True, "asset": result["asset"],
                "adopted": bool(adopted_specs), "canvasItems": [{key: item[key] for key in
                    ("id", "revision", "visible", "position", "width", "height")} for item in items],
                "guidance": "Inspect this existing asset directly. Local copies and extracted inspection frames do not need publishing or new canvas items. Publish only new deliverables; create another display only when requested."}}
        return result


@app.callback()
def options(ctx: typer.Context,
            project: Annotated[UUID | None, typer.Option(envvar="OPENDIRECTOR_PROJECT_ID", help="Target project UUID.")] = None,
            url: Annotated[str, typer.Option(envvar="OPENDIRECTOR_API_URL", help="Running OpenDirector server.")] = "http://127.0.0.1:18000",
            session: Annotated[UUID | None, typer.Option(envvar="OPENDIRECTOR_SESSION", help="Existing authorized edit session.")] = None,
            operation_id: Annotated[UUID | None, typer.Option(help="Stable write identity for safe replay.")] = None):
    client = Client(project, url, session, operation_id)
    ctx.obj = client

    def close():
        try:
            if client.opened and client.owns_session:
                client.request("DELETE", f"/api/creation/sessions/{client.session}")
        finally:
            client.http.close()
    ctx.call_on_close(close)


class LogLevel(str, Enum):
    debug = "debug"
    info = "info"
    warning = "warning"
    error = "error"
    critical = "critical"


PortOption = Annotated[int, typer.Option(min=1, max=65535, help="Local API port.")]
WebPortOption = Annotated[int, typer.Option(min=1, max=65535, help="Vite development port.")]


@app.command("serve", help="Start the API and serve the built application.")
def serve(port: PortOption = 8000, web_port: WebPortOption = 5173, log_level: LogLevel = LogLevel.info):
    from opendirector.launcher import start
    raise typer.Exit(start("serve", port, web_port, log_level.value))


@app.command("dev", help="Start the API and Vite development server.")
def dev(port: PortOption = 8000, web_port: WebPortOption = 5173, log_level: LogLevel = LogLevel.info):
    from opendirector.launcher import start
    raise typer.Exit(start("dev", port, web_port, log_level.value))


def emit(value):
    if isinstance(value, dict) and "changed" in value:
        value = dict(value)
        for object_type, field in (("asset", "assetIds"), ("canvas_item", "itemIds"), ("generation_spec", "specIds")):
            identities = [item["id"] for item in value["changed"] if item["objectType"] == object_type]
            if identities:
                value[field] = identities
                if len(identities) == 1:
                    value[field[:-1]] = identities[0]
    typer.echo(json.dumps(value, ensure_ascii=False, indent=2))


@group("project").command("show", help="Read the current authoritative project snapshot.")
def project_show(ctx: typer.Context):
    ctx.obj.command = ctx.command_path
    emit(ctx.obj.snapshot())


@group("project").command("list", help="List available projects.")
def project_list(ctx: typer.Context):
    if ctx.obj.live:
        raise ProjectError("Agent execution is scoped to its current project. Use opendirector project show.")
    emit(ctx.obj.request("GET", "/api/creation/projects"))


def select_model(models, selector):
    try:
        identity = str(UUID(selector))
    except ValueError:
        identity = None
    matches = [model for model in models if model["id"] == identity] if identity else []
    if not matches:
        matches = [model for model in models if model["modelId"] == selector]
    if not matches:
        raise ProjectError(f"Model {selector!r} was not found. Run opendirector model list --search {shlex.quote(selector)}.")
    if len(matches) > 1:
        candidates = [{key: model[key] for key in ("id", "modelId", "kind", "url")} for model in matches]
        raise ProjectError("Multiple model configurations match. Select a configuration UUID. Candidates: " +
                           json.dumps(candidates, ensure_ascii=False))
    return matches[0]


@group("model").command("list", help="Find model configurations by media kind or model name.")
def model_list(ctx: typer.Context,
               kind: Annotated[Literal["agent", "image", "video", "audio", "vision"] | None,
                               typer.Option(help="Filter by model kind.")] = None,
               search: Annotated[str, typer.Option(help="Case-insensitive substring of model name or configuration UUID.")] = ""):
    ctx.obj.command = ctx.command_path
    emit([model for model in ctx.obj.models()
          if (kind is None or model["kind"] == kind)
          and (search.casefold() in model["modelId"].casefold() or search.casefold() in model["id"].casefold())])


@group("model").command("show", help="Read one model's configuration and supported input/output capabilities.")
def model_show(ctx: typer.Context,
               selector: Annotated[str, typer.Argument(help="Configuration UUID or unique exact model name.")]):
    ctx.obj.command = ctx.command_path
    emit(select_model(ctx.obj.models(), selector))


@group("asset").command("import", help="Register a local file as a project asset.")
def asset_import(ctx: typer.Context,
                 file: Annotated[Path, typer.Argument(exists=True, dir_okay=False, readable=True, help="Path of a downloaded local file in the execution directory.")],
                 kind: Annotated[str, typer.Option(help="Expected media kind, e.g. image or video.")],
                 name: Annotated[str | None, typer.Option(help="Asset display name.")] = None):
    client = ctx.obj
    client.command = ctx.command_path
    if client.live:
        # Server resolves and confines this path to the turn's execution directory.
        emit(client.execute("artifact.publish", {"path": str(file), "name": name or file.name, "expectedKind": kind}))
        return
    operation = client.operation_id or uuid4()
    handle = operation
    payload = {"uploadHandle": str(handle), "name": name or file.name, "expectedKind": kind}
    previous = client.http.get(client.path(f"/receipts/{operation}"))
    if previous.status_code == 200:
        receipt = previous.json()
        command = parse_command({"type": "asset.import", "commandId": operation,
                                 "projectId": client.project, "payload": payload})
        if receipt["inputFingerprint"] != command_fingerprint(command):
            raise ProjectError("Operation ID was already used with different import arguments.")
        created = next((item for item in receipt["changed"] if item["objectType"] == "asset"), None)
        if created:
            asset = client.request("GET", client.path(f"/assets/{created['id']}"))
            digest = sha256()
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if asset["fingerprint"] != "sha256:" + digest.hexdigest():
                raise ProjectError("Operation ID was already used with different file content.")
        emit(receipt)
        if receipt["status"] == "rejected":
            raise typer.Exit(1)
        return
    if previous.status_code != 404:
        raise ProjectError(previous.text, previous.status_code)
    client.open()
    with file.open("rb") as stream:
        client.request("PUT", client.path(f"/uploads/{handle}"),
            headers={"X-Asset-Name": quote(name or file.name), "X-Asset-Kind": kind}, content=stream)
    emit(client.execute("asset.import", payload, identity=operation))


@group("canvas").command("add-material", help="Display a registered asset as a new canvas item.")
def add_material(ctx: typer.Context, asset: Annotated[UUID, typer.Option(help="Registered project asset ID.")],
                 x: Annotated[float, typer.Option(help="Canvas X coordinate. Choose using the current item positions and sizes.")],
                 y: Annotated[float, typer.Option(help="Canvas Y coordinate. Choose using the current item positions and sizes.")],
                 item_id: Annotated[UUID | None, typer.Option(help="New canvas item UUID.")] = None):
    client = ctx.obj
    client.command = ctx.command_path
    snapshot = client.snapshot()
    source = next((value for value in snapshot["assets"] if value["id"] == str(asset)), None)
    if source is None:
        raise ProjectError("Asset is not registered in this project.")
    reference = {key: source[key] for key in ("revision", "fingerprint", "kind")}
    reference["assetId"] = source["id"]
    emit(client.execute("canvas.show", {"item": {
        "id": str(item_id or client.operation_id or uuid4()), "projectId": snapshot["project"]["id"],
        "kind": source["kind"], "position": {"x": x, "y": y},
        "binding": {"role": "material", "objectRef": reference},
    }}))


@group("video").command("create", help="Create a visible, editable video generation node with its input references.")
def video_create(ctx: typer.Context,
                 model: Annotated[str, typer.Option(help="Video model configuration UUID or unique exact model name from opendirector model list.")],
                 prompt: Annotated[str, typer.Option(help="Video generation prompt.")],
                 duration: Annotated[float, typer.Option(min=0, help="Video duration in seconds.")],
                 x: Annotated[float, typer.Option(help="Canvas X coordinate. Choose using the current item positions and sizes.")],
                 y: Annotated[float, typer.Option(help="Canvas Y coordinate. Choose using the current item positions and sizes.")],
                 first_frame: Annotated[UUID | None, typer.Option(help="Source image canvas item for first-frame mode.")] = None,
                 reference_item: Annotated[list[UUID] | None, typer.Option(help="Source canvas items for reference mode. Repeat for multiple inputs.")] = None):
    client = ctx.obj
    client.command = ctx.command_path
    config = select_model([value for value in client.models() if value["kind"] == "video"], model)
    if first_frame and reference_item:
        raise ProjectError("Choose --first-frame or --reference-item for the selected video mode.")
    allowed = config["inputRules"]["videoModes"]
    if first_frame:
        mode = "first_frame"
    elif reference_item:
        mode = "reference"
    else:
        mode = allowed[0]
    if mode not in allowed:
        raise ProjectError(f"Selected model allows video modes {allowed}; requested {mode}.")
    snapshot = client.snapshot()
    operation = client.operation_id or uuid4()
    spec_id, item_id = str(uuid5(operation, "spec")), str(uuid5(operation, "item"))
    project_id = snapshot["project"]["id"]
    references = []
    for index, source_id in enumerate(([first_frame] if first_frame else reference_item) or []):
        source = next((item for item in snapshot["canvasItems"] if item["id"] == str(source_id)), None)
        if source is None:
            raise ProjectError(f"Source canvas item {source_id} is not in this project.")
        references.append({"id": str(uuid5(operation, f"reference-{index}")), "projectId": project_id,
            "targetSpecId": spec_id, "role": "first_frame" if first_frame else "reference",
            "order": index, "binding": "follow_current", "source": {"id": str(source_id)}})
    receipt = client.execute("canvas.createGeneration", {
        "spec": {"id": spec_id, "projectId": project_id, "kind": "video", "purpose": "generation",
                 "modelConfigId": config["id"], "prompt": prompt,
                 "parameters": {"videoMode": mode, "durationSeconds": duration}},
        "item": {"id": item_id, "projectId": project_id, "kind": "video",
                 "position": {"x": x, "y": y},
                 "binding": {"role": "generation", "objectRef": {"id": spec_id}}},
        "references": references,
    }, identity=operation)
    changed = {item["objectType"]: item for item in receipt["changed"]}
    spec_revision = changed["generation_spec"]["revision"]
    item_revision = changed["canvas_item"]["revision"]
    submit = ["opendirector", "--project", project_id, "--operation-id", str(uuid5(operation, "submit")), "generation", "submit",
              "--spec-id", spec_id, "--expected-spec-revision", str(spec_revision),
              "--origin-item-id", item_id,
              "--expected-version", f"generation_spec:{spec_id}:{spec_revision}",
              "--expected-version", f"canvas_item:{item_id}:{item_revision}"]
    emit({**receipt, "specId": spec_id, "itemId": item_id,
          "next": {"description": "Submit this configured video generation.",
                   "command": shlex.join(submit)}})


@group("job").command("show", help="Read job status once. Use job wait to wait for completion.")
def job_show(ctx: typer.Context, job_id: UUID):
    ctx.obj.command = ctx.command_path
    emit(ctx.obj.query("job.get", objectId=str(job_id)))


@group("job").command("wait", help="Wait for a job to reach a terminal state.")
def job_wait(ctx: typer.Context, job_id: UUID,
             timeout: Annotated[float, typer.Option(min=0, help="Maximum wait in seconds.")] = 300):
    import time
    ctx.obj.command = ctx.command_path
    ctx.obj.activity = {"id": str(uuid4()), "kind": "job.wait"}
    deadline = time.monotonic() + timeout
    while True:
        result = ctx.obj.query("job.get", objectId=str(job_id))
        job = result.get("job", result)
        if job.get("status") in {"succeeded", "failed", "cancelled", "interrupted"}:
            emit(result)
            if job["status"] != "succeeded":
                raise typer.Exit(1)
            return
        if time.monotonic() >= deadline:
            emit(result)
            raise typer.Exit(2)
        time.sleep(min(1, max(0, deadline - time.monotonic())))


@app.command("query", help="Read project objects, versions, previews or execution status.")
def query(ctx: typer.Context, kind: str,
          object_id: Annotated[UUID | None, typer.Option()] = None,
          file: Annotated[Path | None, typer.Option(help="Additional query arguments as JSON; use - for stdin.")] = None):
    ctx.obj.command = ctx.command_path
    if kind == "asset":
        raise ValueError("Unknown query type 'asset'. Use query object.get --object-id <asset-id> to read the asset, "
                         "or query asset.preview --object-id <asset-id> for preview access.")
    arguments = read_file(file) if file else {}
    if object_id:
        arguments["objectId"] = str(object_id)
    emit(ctx.obj.query(kind, **arguments))


def read_file(path):
    value = json.loads(sys.stdin.read() if str(path) == "-" else path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object.")
    return value


def register_command(kind, model):
    namespace, action = kind.split(".", 1)
    payload_schema = model.model_json_schema()
    payload = model.model_fields["payload"].annotation
    properties = payload.model_json_schema().get("properties", {})
    parameters = [
        inspect.Parameter("ctx", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=typer.Context),
        inspect.Parameter("file", inspect.Parameter.KEYWORD_ONLY, default=None,
            annotation=Annotated[Path | None, typer.Option(help="Command JSON file with payload and expectedVersions; - reads stdin.")]),
    ]
    for name, definition in properties.items():
        description = definition.get("description", name)
        if name == "spec":
            description += " JSON object, not a spec ID. Overrides the entire payload.spec from --file."
        if kind == "generationSpec.update" and name == "spec":
            description += " Full replacement: copy the current spec, change intended fields, and keep all other fields."
        parameters.append(inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY, default=None,
            annotation=Annotated[str | None, typer.Option("--" + kebab(name), help=description)]))
    parameters.append(inspect.Parameter("help_field", inspect.Parameter.KEYWORD_ONLY, default=None,
        annotation=Annotated[str | None, typer.Option(help="Expand a structured field path from this command's help.")]))
    parameters.append(inspect.Parameter("expected_version", inspect.Parameter.KEYWORD_ONLY, default=None,
        annotation=Annotated[list[str] | None, typer.Option(help="Repeat object_type:UUID:revision for each changed existing object.")]))

    def execute(ctx, file=None, expected_version=None, help_field=None, **values):
        ctx.obj.command = ctx.command_path
        if help_field is not None:
            emit(command_help(payload_schema, help_field, ctx.obj.project or UUID(int=0)))
            return
        body = read_file(file) if file else {"payload": {}}
        if body.get("type", kind) != kind:
            raise ValueError("Command file type does not match this subcommand.")
        arguments = dict(body.get("payload", {}))
        for name, value in values.items():
            if value is not None:
                definition = properties[name]
                alternatives = definition.get("anyOf", definition.get("oneOf", [definition]))
                accepts_string = any(option.get("type") == "string" for option in alternatives)
                if accepts_string and (value != "null" or len(alternatives) == 1):
                    arguments[name] = value
                else:
                    try:
                        arguments[name] = json.loads(value)
                    except json.JSONDecodeError as error:
                        hint = (" --spec needs a complete JSON object, not a configuration ID. Put the ID in payload.spec.id; "
                                "if --file already contains it, omit --spec.") if name == "spec" else ""
                        raise ValueError(f"--{kebab(name)}: invalid JSON at column {error.colno}.{hint} "
                                         f"Inspect --help-field payload.{name}.") from None
        if kind == "generationSpec.update" and isinstance(arguments.get("spec"), dict):
            required = ("purpose", "modelConfigId", "prompt", "promptContent", "parameters", "currentResultId")
            missing = [f"payload.spec.{field}" for field in required if field not in arguments["spec"]]
            if missing:
                raise ValueError("generationSpec.update replaces the complete configuration; missing fields: " +
                                 ", ".join(missing) + ". Read the current spec with query object.get --object-id <spec-id>, "
                                 "change only intended fields, and submit the full spec with its current expected version. "
                                 "Use explicit null to clear nullable fields.")
        versions = list(body.get("expectedVersions", []))
        for value in expected_version or []:
            object_type, identity, revision = value.split(":")
            versions.append({"objectType": object_type, "id": str(UUID(identity)), "revision": int(revision)})
        emit(ctx.obj.execute(kind, arguments, versions, body.get("expectedPreview")))
    execute.__signature__ = inspect.Signature(parameters)
    help = command_help(payload_schema, "", UUID(int=0)) if kind in COMMANDS else None
    description = model.__doc__
    if kind == "generation.submit":
        description += " Accepted receipts return job wait commands; use them to wait for completion."
    group(kebab(namespace)).command(kebab(action), help=description,
        epilog=("Example command document for --file:\n" + json.dumps(help["example"], ensure_ascii=False, indent=2) +
                "\nUse --help-field payload to inspect structured fields and branches.") if help else None)(execute)


for command_type, command_model in COMMAND_MODELS.items():
    if command_type in COMMANDS or command_type in {"project.create", "project.trash", "project.restore"}:
        register_command(command_type, command_model)


def main():
    try:
        result = app(prog_name="opendirector", standalone_mode=False)
        raise SystemExit(result if isinstance(result, int) else 0)
    except UsageError as error:
        typer.echo(error.format_message(), err=True)
        if error.ctx is not None:
            with redirect_stdout(sys.stderr):
                typer.echo(error.ctx.get_help(), err=True)
        raise SystemExit(error.exit_code)
    except ValidationError as error:
        emit({"error": [{"field": ".".join(str(part) for part in item["loc"]), "reason": item["msg"]}
                       for item in error.errors(include_input=False, include_url=False, include_context=False)]})
        raise SystemExit(1)
    except (ProjectError, OSError, ValueError, httpx.HTTPError) as error:
        value = {"error": str(error)}
        if isinstance(error, ProjectError):
            value['code'] = error.code
            value['error'] = timeline_error_message(error.code, os.environ.get('OPENDIRECTOR_LANGUAGE', 'en-US')) or str(error)
        emit(value)
        raise SystemExit(1)


@group('voice').command('list', help='Read the voice library and model requirements. For large MOSS libraries use --page-size 150.')
def voice_list(ctx: typer.Context,
               model: Annotated[UUID, typer.Option(help='Speech model configuration UUID.')],
               page_size: Annotated[int | None, typer.Option(min=1, max=150, help='MOSS voices per page. Omit to read the full library.')] = None,
               after: Annotated[str | None, typer.Option(help='Continue from the previous nextCursor using --page-size and --connection.')] = None,
               connection: Annotated[str | None, typer.Option(help='Connection ID from the previous page.')] = None):
    client = ctx.obj
    client.command = ctx.command_path
    arguments = {'modelConfigId': str(model)}
    if page_size is not None: arguments['pageSize'] = page_size
    if after is not None: arguments['after'] = after
    if connection is not None: arguments['connectionId'] = connection
    emit(client.call('voice_list', arguments) if client.live else client.request('GET', '/api/voices', params=arguments))


@group('voice').command('create', help='Upload an authorized recording to the speech model voice library.')
def voice_create(ctx: typer.Context,
                 file: Annotated[Path, typer.Argument(exists=True, dir_okay=False, readable=True)],
                 model: Annotated[UUID, typer.Option(help='Speech model configuration UUID.')],
                 connection: Annotated[str, typer.Option(help='Connection identity from voice list.')],
                 name: Annotated[str, typer.Option(help='Readable voice name.')],
                 consent: Annotated[str | None, typer.Option(help='Consent recording ID (required by vLLM-Omni).')] = None,
                 ref_text: Annotated[str | None, typer.Option(help='Accurate transcript, required by some models.')] = None,
                 speaker_description: Annotated[str | None, typer.Option(help='Optional provider voice description.')] = None):
    client = ctx.obj
    client.command = ctx.command_path
    fields = dict(connectionId=connection, name=name)
    if consent is not None: fields['consent'] = consent
    if ref_text is not None: fields['refText'] = ref_text
    if speaker_description is not None: fields['speakerDescription'] = speaker_description
    if client.live:
        emit(client.call('voice_create', {**fields, 'modelConfigId': str(model), 'path': str(file.resolve())}))
    else:
        from opendirector.domain.voices import voice_error
        with file.open('rb') as stream: data = stream.read(10 * 1024 * 1024 + 1)
        if len(data) > 10 * 1024 * 1024: raise voice_error('voice_size', 413)
        emit(client.request('POST', '/api/voices', params={'modelConfigId': str(model)},
                            data=fields, files={'audio_sample': (file.name, data)}))


@group('voice').command('delete', help='Delete a provider-supported uploaded voice with explicit authorization.')
def voice_delete(ctx: typer.Context,
                 voice_id: Annotated[str, typer.Argument(help='Provider voice identity.')],
                 model: Annotated[UUID, typer.Option(help='Speech model configuration UUID.')],
                 connection: Annotated[str, typer.Option(help='Connection identity from voice list.')]):
    client = ctx.obj
    client.command = ctx.command_path
    arguments = dict(modelConfigId=str(model), connectionId=connection, voiceId=voice_id)
    if client.live: emit(client.call('voice_delete', arguments))
    else:
        response = client.http.delete('/api/voices/' + quote(voice_id, safe=''), params={'modelConfigId': str(model), 'connectionId': connection})
        if not response.is_success: raise ProjectError(response.text, response.status_code)
        emit({'deleted': True, 'voiceId': voice_id, 'connectionId': connection})


if __name__ == "__main__":
    main()
