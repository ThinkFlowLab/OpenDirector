"""The video gateway rewrites listed models and relays everything else untouched."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.parse import parse_qsl

import httpx
import pytest
from starlette.testclient import TestClient

from opendirector import launcher
from opendirector import video_gateway as gateway


pytestmark = pytest.mark.cpu
ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "tools/video-gateway/video-gateway.example.yaml"


def entry(**extra):
    base = {"backend": "http://b", "backend_model": "served", "set": {}, "defaults": {}, "extra_params": {}, "lora": None, "strip_lora": False}
    return {**base, **extra}


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_rewrite_forces_set_fills_defaults_and_merges_extra_params():
    fields = {"model": "alias", "num_inference_steps": "8", "size": "832x480", "extra_params": '{"task": "ref2va", "audio_flow_shift": 5}'}
    lora = {"name": "n", "path": "/p", "scale": 1.0}
    new, changes = gateway.rewrite(entry(set={"num_inference_steps": 4, "flow_shift": 12}, defaults={"size": "1x1", "fps": 24},
                                         extra_params={"audio_flow_shift": 3}, lora=lora), fields)
    assert new["model"] == "served" and new["num_inference_steps"] == "4" and new["flow_shift"] == "12"
    assert new["size"] == "832x480" and new["fps"] == "24"          # a default never replaces a sent value
    assert json.loads(new["extra_params"]) == {"task": "ref2va", "audio_flow_shift": 3}
    assert json.loads(new["lora"]) == lora
    assert any(change.startswith("num_inference_steps=4 (was 8)") for change in changes)


def test_structured_values_are_sent_as_json_text():
    new, _ = gateway.rewrite(entry(set={"enabled": True, "frame_indices": [0, 80], "options": {"tiled": False}}), {"model": "alias"})
    assert (new["enabled"], new["frame_indices"], new["options"]) == ("true", "[0, 80]", '{"tiled": false}')


def test_lora_is_stripped_only_when_the_entry_says_null():
    fields = {"model": "alias", "lora": '{"name": "client"}'}
    assert "lora" not in gateway.rewrite(entry(strip_lora=True), fields)[0]
    assert gateway.rewrite(entry(), fields)[0]["lora"] == '{"name": "client"}'


def test_multipart_round_trip_keeps_files_byte_for_byte():
    payload = bytes(range(256)) * 4 + b"\r\n--not-the-boundary\r\n"
    request = httpx.Request("POST", "http://x/v1/videos", data={"model": "alias", "prompt": "<Picture 1> 舞"},
                            files=[("input_references", ("a.png", payload, "image/png")), ("input_references", ("b.png", b"second", "image/png"))])
    body = request.read()
    boundary = request.headers["content-type"].split("boundary=")[1].encode()
    parts = gateway.split_multipart(body, boundary)
    assert [(name, filename) for name, filename, _, _ in parts] == [("model", None), ("prompt", None), ("input_references", "a.png"), ("input_references", "b.png")]
    assert parts[2][3] == payload and parts[1][3].decode() == "<Picture 1> 舞"
    assert gateway.join_multipart(parts, boundary) == body
    rebuilt = gateway.join_multipart([gateway.text_part("model", "served"), *parts[1:], gateway.text_part("lora", "{}")], boundary)
    again = gateway.split_multipart(rebuilt, boundary)
    assert again[0][3] == b"served" and again[2][3] == payload and again[-1][0] == "lora"


@pytest.mark.parametrize("text, message", [
    ("- not a mapping", "must be a mapping"),
    ("models: {}", "`default_backend` must be the URL"),
    ("default_backend: http://d\nlisten: {port: '8101'}", "`listen.port` must be a port number"),
    ("default_backend: http://d\nmodels:\n  a: {set: {}}", "'a' needs a `backend`"),
    ("default_backend: http://d\nmodels:\n  a: {backend: http://b, stepz: 4}", "unknown keys: stepz"),
    ("default_backend: http://d\nmodels:\n  a: {backend: http://b, lora: {name: n}}", "`lora` needs `name` and `path`"),
    ("default_backend: http://d\nmodels:\n  a: {backend: '127.0.0.1:8091'}", "'a' needs a `backend` URL that starts with http"),
    ("default_backend: http://d\nmodels:\n  a: {backend: http://b, 7: x}", "unknown keys: 7"),
    ("default_backend: http://d\nmodels:\n  a: {backend: http://b, lora: {name: n, path: p, scale: strong}}", "`lora.scale` must be a number"),
    ("default_backend: http://d\nmodels:\n  a: {backend: http://b, lora: {name: n, path: p, scale: }}", "`lora.scale` must be a number"),
    ("default_backend: http://d\nmodels:\n  a: {backend: http://b, set: {negative_prompt: }}", "`set.negative_prompt` has no value"),
], ids=["not-a-mapping", "no-default-backend", "text-port", "no-backend", "unknown-key", "lora-without-path",
        "backend-without-scheme", "non-text-key", "text-scale", "empty-scale", "empty-set-value"])
def test_config_errors_name_the_problem(tmp_path, text, message):
    path = tmp_path / "video-gateway.yaml"
    path.write_text(text)
    with pytest.raises(gateway.ConfigError, match=message):
        gateway.load(path)


def test_the_example_configuration_loads():
    config = gateway.load(EXAMPLE)
    assert config["host"] == "127.0.0.1" and config["port"] == 8101
    assert config["models"]["Pika-Labs/Pika-H3-Flex-Turbo-4step"]["set"]["num_inference_steps"] == 4
    # The LoRA lives on the model server, so a path that is absent here is still accepted.
    assert config["models"]["Pika-Labs/Pika-H3-Flex-Turbo-8step-HD"]["lora"]["path"].startswith("/path/to/")
    assert config["models"]["MiniMaxAI/MiniMax-H3-Ref2VA"]["strip_lora"]


def served(tmp_path):
    """A gateway with one listed model, its backends replaced by a recorder."""
    config = tmp_path / "video-gateway.yaml"
    config.write_text("default_backend: http://default\nmodels:\n  listed:\n    backend: http://special\n    backend_model: served\n"
                      "    set: {num_inference_steps: 4}\n    lora: {name: n, path: /server/adapter.safetensors}\n")
    seen = []

    def backend(request):
        # Only creates carry a buffered body; polls are relayed as streams the recorder does not read.
        seen.append((request.url.host, request.url.path, request.headers.get("content-type"),
                     request.content if request.method == "POST" else b""))
        document = {"data": [{"id": "native-model"}]} if request.url.path == "/v1/models" else {"id": "job-" + request.url.host}
        # Real backends answer as streams, which is what the gateway relays.
        return httpx.Response(200, headers={"content-type": "application/json"}, stream=httpx.ByteStream(json.dumps(document).encode()))

    return TestClient(gateway.application(gateway.Gateway(config, httpx.MockTransport(backend)))), seen, config


def test_backends_are_reached_directly_whatever_proxy_the_environment_names(tmp_path, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:7890")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:7890")
    config = tmp_path / "video-gateway.yaml"
    config.write_text("default_backend: http://127.0.0.1:8091\n")
    assert gateway.Gateway(config).client.trust_env is False


def test_an_unlisted_model_reaches_the_default_backend_byte_for_byte(tmp_path):
    client, seen, _ = served(tmp_path)
    request = httpx.Request("POST", "http://x/v1/videos", data={"model": "native-model", "num_inference_steps": "8", "lora": "{}"},
                            files={"input_references": ("a.png", b"\x89PNG-bytes", "image/png")})
    body = request.read()
    response = client.post("/v1/videos", content=body, headers={"content-type": request.headers["content-type"]})
    assert response.json() == {"id": "job-default"}
    host, path, content_type, content = seen[-1]
    assert (host, path) == ("default", "/v1/videos") and content == body and content_type == request.headers["content-type"]
    # The job it created is polled on the same backend.
    client.get("/v1/videos/job-default")
    assert seen[-1][:2] == ("default", "/v1/videos/job-default")


def test_a_listed_model_is_rewritten_and_sent_to_its_own_backend(tmp_path):
    client, seen, _ = served(tmp_path)
    request = httpx.Request("POST", "http://x/v1/videos", data={"model": "listed", "num_inference_steps": "8"},
                            files={"input_references": ("a.png", b"\x89PNG-bytes", "image/png")})
    client.post("/v1/videos", content=request.read(), headers={"content-type": request.headers["content-type"]})
    host, _, content_type, content = seen[-1]
    parts = {name: body for name, _, _, body in gateway.split_multipart(content, content_type.split("boundary=")[1].encode())}
    assert host == "special" and parts["model"] == b"served" and parts["num_inference_steps"] == b"4"
    assert json.loads(parts["lora"]) == {"name": "n", "path": "/server/adapter.safetensors", "scale": 1.0}
    assert parts["input_references"] == b"\x89PNG-bytes"
    client.get("/v1/videos/job-special")
    assert seen[-1][:2] == ("special", "/v1/videos/job-special")


def test_repeated_and_typed_text_parts_survive_a_rewrite(tmp_path):
    client, seen, _ = served(tmp_path)
    boundary = b"edge"
    typed = b'Content-Disposition: form-data; name="extra_params"\r\nContent-Type: application/json'
    parts = [gateway.text_part("model", "listed"), gateway.text_part("tag", "one"), gateway.text_part("tag", "two"),
             ("extra_params", None, typed, b'{"task": "ref2va"}'), gateway.text_part("num_inference_steps", "8"),
             gateway.text_part("num_inference_steps", "8")]
    client.post("/v1/videos", content=gateway.join_multipart(parts, boundary), headers={"content-type": "multipart/form-data; boundary=edge"})
    sent = gateway.split_multipart(seen[-1][3], boundary)
    assert [(name, content) for name, _, _, content in sent if name == "tag"] == [("tag", b"one"), ("tag", b"two")]
    assert [content for name, _, _, content in sent if name == "num_inference_steps"] == [b"4"]     # a forced field is written once
    assert next(head for name, _, head, _ in sent if name == "extra_params") == typed


def test_a_urlencoded_request_for_a_listed_model_is_rewritten(tmp_path):
    client, seen, _ = served(tmp_path)
    client.post("/v1/videos", content=b"model=listed&num_inference_steps=8&prompt=a+b%26c&tag=1&tag=2",
                headers={"content-type": "application/x-www-form-urlencoded"})
    host, _, _, content = seen[-1]
    sent = parse_qsl(content.decode())
    assert host == "special" and sent[:5] == [("model", "served"), ("num_inference_steps", "4"), ("prompt", "a b&c"), ("tag", "1"), ("tag", "2")]
    assert json.loads(dict(sent)["lora"])["name"] == "n"


def test_a_body_the_gateway_cannot_read_goes_to_the_default_backend_untouched(tmp_path):
    client, seen, _ = served(tmp_path)
    body = b"\xff\xfe not a form"
    client.post("/v1/videos", content=body, headers={"content-type": "application/octet-stream"})
    assert seen[-1][0] == "default" and seen[-1][3] == body


def restarted(tmp_path, default):
    """A gateway that never saw `job-special` created; `default` answers for the default backend."""
    config = tmp_path / "video-gateway.yaml"
    config.write_text("default_backend: http://default\nmodels:\n  listed: {backend: http://special}\n")
    seen = []

    def backend(request):
        seen.append((request.method, request.url.host, request.headers.get("authorization")))
        if request.url.host == "default":
            return default(request)
        if request.headers.get("authorization") != "Bearer key":
            return httpx.Response(401, stream=httpx.ByteStream(b"{}"))
        return httpx.Response(200, headers={"content-type": "application/json"}, stream=httpx.ByteStream(b'{"id": "job-special"}'))

    return TestClient(gateway.application(gateway.Gateway(config, httpx.MockTransport(backend)))), seen


def unreachable(request):
    raise httpx.ConnectError("refused", request=request)


@pytest.mark.parametrize("default", [
    lambda request: httpx.Response(404, stream=httpx.ByteStream(b"{}")),
    lambda request: httpx.Response(401, stream=httpx.ByteStream(b"{}")),
    lambda request: httpx.Response(503, stream=httpx.ByteStream(b"{}")),
    unreachable,
], ids=["unknown-there", "refused-there", "failing-there", "down"])
@pytest.mark.parametrize("method", ["GET", "DELETE"])
def test_after_a_restart_a_job_is_found_on_the_backend_that_answers_for_it(tmp_path, default, method):
    client, seen = restarted(tmp_path, default)
    response = client.request(method, "/v1/videos/job-special", headers={"authorization": "Bearer key"})
    assert response.status_code == 200
    # The lookup carries the caller's key, and the request itself lands on the owner.
    assert seen[-1] == (method, "special", "Bearer key") and ("GET", "special", "Bearer key") in seen
    seen.clear()
    client.get("/v1/videos/job-special/content", headers={"authorization": "Bearer key"})
    assert seen == [("GET", "special", "Bearer key")]              # remembered: no second lookup


def test_a_job_no_backend_knows_is_not_pinned_to_one(tmp_path):
    client, seen = restarted(tmp_path, lambda request: httpx.Response(404, stream=httpx.ByteStream(b"{}")))
    assert client.get("/v1/videos/job-special").status_code == 404   # no key: the owner refuses the lookup
    assert client.get("/v1/videos/job-special", headers={"authorization": "Bearer key"}).status_code == 200


def test_model_list_shows_listed_names_and_the_default_backends_own(tmp_path):
    client, _, _ = served(tmp_path)
    assert [item["id"] for item in client.get("/v1/models").json()["data"]] == ["listed", "native-model"]


def test_an_edited_file_is_picked_up_and_a_broken_edit_keeps_the_last_table(tmp_path):
    client, _, config = served(tmp_path)
    good = config.read_text()

    def rewrite(text):
        # Step the timestamp explicitly: two writes can share one on a coarse filesystem clock.
        stamp = config.stat().st_mtime_ns + 1_000_000_000
        config.write_text(text)
        os.utime(config, ns=(stamp, stamp))

    rewrite(good.replace("listed:", "renamed:"))
    assert [item["id"] for item in client.get("/v1/models").json()["data"]] == ["renamed", "native-model"]
    for broken in ("models: [broken", good.replace("path: /server/adapter.safetensors", "path: p, scale: strong")):
        rewrite(broken)
        assert [item["id"] for item in client.get("/v1/models").json()["data"]] == ["renamed", "native-model"]


# --- started with OpenDirector -----------------------------------------------------------------------------

def test_the_gateway_is_configured_by_an_explicit_file_or_the_one_beside_the_model_settings(tmp_path):
    assert launcher.video_gateway_config(None, tmp_path) is None
    default = tmp_path / ".opendirector" / "video-gateway.yaml"
    default.parent.mkdir()
    default.write_text("default_backend: http://d\n")
    assert launcher.video_gateway_config(None, tmp_path) == default
    explicit = tmp_path / "other.yaml"
    assert launcher.video_gateway_config(explicit, tmp_path) == explicit.resolve()


@pytest.fixture
def unspawned(tmp_path, monkeypatch):
    """A launcher that may check its inputs but must not start a process."""
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html>")
    monkeypatch.setattr(launcher, "web_root", lambda: web)
    monkeypatch.setattr(launcher, "data_root", lambda: tmp_path / "data")

    def refuse(*args, **kwargs):
        raise AssertionError("nothing may be spawned before the gateway configuration is accepted")
    monkeypatch.setattr(launcher.subprocess, "Popen", refuse)
    return tmp_path


def test_an_invalid_gateway_configuration_stops_the_start_before_anything_is_spawned(unspawned, capsys):
    config = unspawned / "gateway.yaml"
    config.write_text("models: {}\n")
    assert launcher.start("serve", free_port(), video_gateway=config) == 1
    message = capsys.readouterr().err
    assert "Video gateway configuration is invalid" in message and "视频转发层配置无效" in message
    assert "`default_backend` must be the URL" in message


def test_a_bound_gateway_port_stops_the_start_and_names_the_setting(unspawned, capsys):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    try:
        config = unspawned / "gateway.yaml"
        config.write_text(f"default_backend: http://d\nlisten: {{port: {listener.getsockname()[1]}}}\n")
        assert launcher.start("serve", free_port(), video_gateway=config) == 1
    finally:
        listener.close()
    message = capsys.readouterr().err
    assert "listen.port" in message and "已被占用" in message and str(config) in message


def test_the_gateway_port_cannot_be_the_application_port(unspawned, capsys):
    port = free_port()
    config = unspawned / "gateway.yaml"
    config.write_text(f"default_backend: http://d\nlisten: {{port: {port}}}\n")
    assert launcher.start("serve", port, video_gateway=config) == 1
    assert "listen.port" in capsys.readouterr().err


def test_in_development_the_gateway_port_cannot_be_the_web_port(tmp_path):
    web_port = free_port()
    config = tmp_path / "gateway.yaml"
    config.write_text(f"default_backend: http://d\nlisten: {{port: {web_port}}}\n")
    with pytest.raises(RuntimeError, match="listen.port"):
        launcher.video_gateway_listen(config, {free_port(), web_port})
    assert launcher.video_gateway_listen(config, {free_port()}) == ("127.0.0.1", web_port)


def test_the_module_entry_point_serves_the_configured_models(tmp_path):
    """The command the launcher runs, as a real process: it listens where the file says and answers."""
    port = free_port()
    config = tmp_path / "video-gateway.yaml"
    # Nothing listens on the default backend, so the list is the configured names alone.
    config.write_text(f"listen: {{port: {port}}}\ndefault_backend: http://127.0.0.1:{free_port()}\n"
                      "models:\n  listed: {backend: 'http://127.0.0.1:9'}\n")
    process = subprocess.Popen([sys.executable, "-m", "opendirector.video_gateway", str(config)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 30
        while not launcher.port_in_use(port):
            assert process.poll() is None, "the gateway exited before listening"
            assert time.monotonic() < deadline, "the gateway did not start listening"
            time.sleep(0.1)
        with httpx.Client(trust_env=False) as client:
            listed = client.get(f"http://127.0.0.1:{port}/v1/models", timeout=20).json()
        assert [item["id"] for item in listed["data"]] == ["listed"]
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_the_module_entry_point_rejects_a_broken_configuration(tmp_path):
    config = tmp_path / "video-gateway.yaml"
    config.write_text("models: {}\n")
    result = subprocess.run([sys.executable, "-m", "opendirector.video_gateway", str(config)], capture_output=True, text=True, timeout=60)
    assert result.returncode != 0 and "`default_backend` must be the URL" in result.stderr
