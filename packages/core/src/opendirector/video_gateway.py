"""Config-driven gateway in front of vLLM-Omni video servers.

A client names a model. When that name is listed in the YAML file, the gateway rewrites the request for
the server that really runs it: the served model name, forced or default form fields (step count, flow
shift, ...), keys inside `extra_params`, and the `lora` the weights need. Any other request is forwarded
to the default backend exactly as it arrived.

`opendirector serve` starts this process when a configuration exists (see launcher.py). The format is
described in docs/guides/video-gateway.md and tools/video-gateway/video-gateway.example.yaml.
"""
import argparse
import json
import logging
import re
import sys
from pathlib import Path

import httpx
import uvicorn
import yaml
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

log = logging.getLogger("opendirector.video_gateway")  # not __name__: the module runs as __main__
MAX_BODY = 768 * 1024 * 1024
HOP = {"host", "connection", "transfer-encoding", "keep-alive", "content-length"}
CREATE = {"/v1/videos", "/v1/videos/sync"}
JOB = re.compile(r"^/v1/videos/(?!sync$)([^/]+)(/content)?$")


class ConfigError(ValueError):
    pass


def load(path: Path) -> dict:
    """Parse and check the model table; raises ConfigError with a message that names the entry."""
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        raise ConfigError(f"cannot read {path}: {error}") from None
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must be a mapping with `default_backend` and `models`")
    models = raw.get("models") or {}
    if not isinstance(models, dict):
        raise ConfigError("`models` must be a mapping of model names")
    default = raw.get("default_backend")
    if not isinstance(default, str) or not default.startswith(("http://", "https://")):
        raise ConfigError("`default_backend` must be the URL that unlisted models are forwarded to")
    table = {}
    for name, entry in models.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("backend"), str):
            raise ConfigError(f"model {name!r} needs a `backend` URL")
        unknown = set(entry) - {"backend", "backend_model", "set", "defaults", "extra_params", "lora"}
        if unknown:
            raise ConfigError(f"model {name!r} has unknown keys: {', '.join(sorted(unknown))}")
        for key in ("set", "defaults", "extra_params"):
            if not isinstance(entry.get(key, {}), dict):
                raise ConfigError(f"model {name!r}: `{key}` must be a mapping")
        lora = entry.get("lora")
        if lora is not None:
            if not isinstance(lora, dict) or not {"name", "path"} <= set(lora):
                raise ConfigError(f"model {name!r}: `lora` needs `name` and `path`")
            # The path belongs to the vLLM-Omni server, which may be another machine: it is sent, not checked.
            lora = {"name": str(lora["name"]), "path": str(lora["path"]), "scale": float(lora.get("scale", 1.0))}
        table[str(name)] = {
            "backend": entry["backend"].rstrip("/"), "backend_model": str(entry.get("backend_model", name)),
            "set": {str(k): v for k, v in entry.get("set", {}).items()},
            "defaults": {str(k): v for k, v in entry.get("defaults", {}).items()},
            "extra_params": dict(entry.get("extra_params", {})),
            "lora": lora, "strip_lora": "lora" in entry and entry["lora"] is None,
        }
    listen = raw.get("listen") or {}
    port = listen.get("port", 8101) if isinstance(listen, dict) else None
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ConfigError("`listen.port` must be a port number between 1 and 65535")
    return {"models": table, "default_backend": default.rstrip("/"),
            "host": str(listen.get("host", "127.0.0.1")), "port": port}


def scalar(value) -> str:
    """Form fields are text; keep booleans and numbers in the spelling the API reads."""
    return ("true" if value else "false") if isinstance(value, bool) else str(value)


def rewrite(entry: dict, fields: dict) -> tuple[dict, list[str]]:
    """Apply one model entry to a request's text fields. Returns the new fields and what changed."""
    new, changes = dict(fields), []

    def put(key, value, *, only_if_missing=False):
        if only_if_missing and key in new:
            return
        if new.get(key) != value:
            changes.append(f"{key}={value if len(value) < 60 else value[:57] + '...'}" + (f" (was {new[key]})" if key in new else ""))
        new[key] = value

    put("model", entry["backend_model"])
    for key, value in entry["set"].items():
        put(key, scalar(value))
    for key, value in entry["defaults"].items():
        put(key, scalar(value), only_if_missing=True)
    if entry["extra_params"]:
        try:
            extra = json.loads(new.get("extra_params") or "{}")
        except ValueError:
            extra = None
        if not isinstance(extra, dict):
            raise ValueError("extra_params is not a JSON object")
        merged = {**extra, **entry["extra_params"]}
        if merged != extra:
            changes.append("extra_params += " + json.dumps({k: v for k, v in entry["extra_params"].items() if extra.get(k) != v}))
            new["extra_params"] = json.dumps(merged)
    if entry["lora"]:
        put("lora", json.dumps(entry["lora"]))
    elif entry["strip_lora"] and "lora" in new:
        changes.append("lora removed")
        del new["lora"]
    return new, changes


# --- multipart/form-data: text fields are rewritten, file parts are carried through byte for byte ------------

def split_multipart(body: bytes, boundary: bytes):
    """Return [(name, filename or None, header block, content)] for every part."""
    delimiter = b"--" + boundary
    chunks = body.split(delimiter)
    if len(chunks) < 3 or not chunks[-1].lstrip().startswith(b"--"):
        raise ValueError("malformed multipart body")
    parts = []
    for chunk in chunks[1:-1]:
        chunk = chunk.removeprefix(b"\r\n").removesuffix(b"\r\n")
        head, separator, content = chunk.partition(b"\r\n\r\n")
        if not separator:
            raise ValueError("malformed multipart part")
        disposition = next((line for line in head.split(b"\r\n") if line.lower().startswith(b"content-disposition")), b"")
        name = re.search(rb'[; ]name="([^"]*)"', disposition)
        filename = re.search(rb'[; ]filename="([^"]*)"', disposition)
        if not name:
            raise ValueError("multipart part without a name")
        parts.append((name.group(1).decode(), filename.group(1).decode() if filename else None, head, content))
    return parts


def join_multipart(parts, boundary: bytes) -> bytes:
    out = bytearray()
    for _, _, head, content in parts:
        out += b"--" + boundary + b"\r\n" + head + b"\r\n\r\n" + content + b"\r\n"
    return bytes(out + b"--" + boundary + b"--\r\n")


def text_part(name: str, value: str):
    return name, None, f'Content-Disposition: form-data; name="{name}"'.encode(), value.encode()


class Gateway:
    def __init__(self, path: Path):
        self.path, self.stamp, self.config = path, None, None
        self.jobs: dict[str, str] = {}  # job id -> backend that owns it
        self.client = httpx.AsyncClient(timeout=None)
        self.reload(required=True)

    def reload(self, required=False):
        """Pick up an edited file; a broken edit keeps serving the last good table."""
        try:
            stamp = self.path.stat().st_mtime_ns
            if stamp == self.stamp:
                return
            self.config, self.stamp = load(self.path), stamp
            log.info("loaded %d models from %s: %s", len(self.config["models"]), self.path, ", ".join(self.config["models"]))
        except (OSError, ConfigError) as error:
            if required:
                raise
            if getattr(self, "_reported", None) != str(error):
                log.error("keeping the previous configuration: %s", error)
                self._reported = str(error)

    def backends(self):
        """Every backend in use, the default one first."""
        return list(dict.fromkeys([self.config["default_backend"], *(entry["backend"] for entry in self.config["models"].values())]))

    @staticmethod
    def error(status, message):
        return JSONResponse({"error": {"message": message, "type": "gateway_error", "code": status}}, status_code=status)

    async def relay(self, request, backend, *, content=None, headers=None, remember=False):
        headers = headers or {k: v for k, v in request.headers.items() if k.lower() not in HOP}
        if content is None:
            content = request.stream()
            if "content-length" in request.headers:
                headers["content-length"] = request.headers["content-length"]
        upstream = self.client.build_request(request.method, backend + request.url.path, params=request.query_params,
                                             headers=headers, content=content)
        try:
            response = await self.client.send(upstream, stream=True)
        except httpx.HTTPError as error:
            return self.error(502, f"backend {backend} is unreachable: {type(error).__name__}")
        passed = {k: v for k, v in response.headers.items() if k.lower() not in HOP - {"content-length"}}
        if remember:
            # An async create answers with a small job document; note which backend owns the job.
            data = await response.aread()
            await response.aclose()
            try:
                job = json.loads(data).get("id")
                if isinstance(job, str):
                    self.jobs[job] = backend
            except (ValueError, AttributeError):
                pass
            kept = {k: v for k, v in passed.items() if k.lower() not in {"content-length", "content-encoding"}}
            return Response(data, status_code=response.status_code, headers=kept)
        return StreamingResponse(response.aiter_raw(), status_code=response.status_code, headers=passed,
                                 background=BackgroundTask(response.aclose))

    async def create(self, request):
        content_type = request.headers.get("content-type", "")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY:
                return self.error(413, "request body is too large for the gateway")
        body = bytes(body)
        multipart = "multipart/form-data" in content_type and "boundary=" in content_type
        try:
            if multipart:
                boundary = content_type.split("boundary=", 1)[1].split(";", 1)[0].strip().strip('"').encode()
                parts = split_multipart(body, boundary)
                fields = {name: content.decode() for name, filename, _, content in parts if filename is None}
            else:
                document = json.loads(body or b"{}")
                fields = {key: value if isinstance(value, str) else json.dumps(value) for key, value in document.items()}
        except (ValueError, UnicodeDecodeError, AttributeError):
            # Not a body the gateway understands, so it cannot name a listed model: forward it as it is.
            fields = {}
        name = fields.get("model")
        entry = self.config["models"].get(name)
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
        remember = request.url.path.rstrip("/") == "/v1/videos"
        if entry is None:
            # Not a listed model: the default backend gets the request byte for byte.
            log.info("%s %s -> %s: passed through unchanged", request.url.path, name, self.config["default_backend"])
            return await self.relay(request, self.config["default_backend"], content=body, headers=headers, remember=remember)
        try:
            new, changes = rewrite(entry, fields)
        except ValueError as error:
            return self.error(400, str(error))
        log.info("%s %s -> %s: %s", request.url.path, name, entry["backend"], "; ".join(changes) or "unchanged")
        if multipart:
            kept = [part for part in parts if part[1] is not None or part[0] in new]
            rebuilt = [text_part(part[0], new[part[0]]) if part[1] is None else part for part in kept]
            rebuilt += [text_part(key, value) for key, value in new.items() if key not in fields]
            body = join_multipart(rebuilt, boundary)
        else:
            def typed(key):
                # Untouched keys keep their original JSON type; rewritten ones are parsed back from text.
                if key in fields and new[key] == fields[key]:
                    return document[key]
                try:
                    return json.loads(new[key])
                except ValueError:
                    return new[key]
            body = json.dumps({key: typed(key) for key in new}).encode()
        return await self.relay(request, entry["backend"], content=body, headers=headers, remember=remember)

    async def handle(self, request):
        self.reload()
        path = request.url.path.rstrip("/") or "/"
        if request.method == "POST" and path in CREATE:
            return await self.create(request)
        if request.method == "GET" and path == "/v1/models":
            # The listed names, then whatever the default backend serves under its own names.
            listed = [{"id": name, "object": "model", "owned_by": "gateway"} for name in self.config["models"]]
            try:
                native = (await self.client.get(self.config["default_backend"] + "/v1/models", timeout=5)).json().get("data", [])
            except (httpx.HTTPError, ValueError, AttributeError):
                native = []
            names = set(self.config["models"])
            return JSONResponse({"object": "list", "data": listed + [item for item in native if item.get("id") not in names]})
        job = JOB.match(path)
        backends = self.backends()
        if job and job.group(1) not in self.jobs and len(backends) > 1 and request.method == "GET":
            # A job from before a restart: ask each backend until one knows it.
            for backend in backends:
                probe = await self.client.get(f"{backend}/v1/videos/{job.group(1)}")
                if probe.status_code != 404:
                    self.jobs[job.group(1)] = backend
                    break
        return await self.relay(request, self.jobs.get(job.group(1), backends[0]) if job else backends[0])


def application(gateway: Gateway) -> Starlette:
    return Starlette(routes=[Route("/{path:path}", gateway.handle, methods=["GET", "POST", "DELETE"])])


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the OpenDirector video gateway")
    parser.add_argument("config", type=Path, help="YAML file that lists the models")
    parser.add_argument("--log-level", choices=("debug", "info", "warning", "error", "critical"), default="info")
    args = parser.parse_args()
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        gateway = Gateway(args.config)
    except (OSError, ConfigError) as error:
        sys.exit(f"video gateway: {error}")
    uvicorn.run(application(gateway), host=gateway.config["host"], port=gateway.config["port"],
                log_level=args.log_level, log_config=None)


if __name__ == "__main__":
    main()
