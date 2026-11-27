"""Run the local API and, in development, Vite from any working directory."""

import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from opendirector.installation import SOURCE_ROOT, data_root, web_root

ROOT = SOURCE_ROOT
VIDEO_GATEWAY_FILE = ".opendirector/video-gateway.yaml"  # beside models.json


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """True when something already accepts connections on the local port."""
    with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.25)
        return probe.connect_ex((host, port)) == 0


def suggested_port(port: int) -> int | None:
    for candidate in range(port + 1, min(port + 50, 65536)):
        if not port_in_use(candidate):
            return candidate
    return None


def require_free_port(port: int, flag: str) -> None:
    """Fail before spawning anything: a bound port must name the real remedy."""
    if not port_in_use(port):
        return
    alternative = suggested_port(port)
    raise RuntimeError(
        f"端口 {port} 已被占用：请关闭占用该端口的程序，或用 {flag} "
        f"{alternative if alternative else '<端口>'} 指定其他端口。")


def video_gateway_config(explicit: Path | None, workspace: Path) -> Path | None:
    """The video gateway runs only when it is configured: the given file, else the one beside the model settings."""
    if explicit is not None:
        return explicit.expanduser().resolve()
    default = workspace / VIDEO_GATEWAY_FILE
    return default if default.is_file() else None


def video_gateway_listen(config: Path, api_port: int) -> tuple[str, int]:
    """Check the configuration and its port before anything is spawned; returns where to reach the gateway."""
    from opendirector.video_gateway import ConfigError, load
    try:
        settings = load(config)
    except ConfigError as error:
        raise RuntimeError(f"Video gateway configuration is invalid / 视频转发层配置无效：{error}") from None
    # A wildcard address is reached through the matching loopback one.
    host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(settings["host"], settings["host"])
    port = settings["port"]
    if port == api_port or port_in_use(port, host):
        raise RuntimeError(
            f"Video gateway port {port} is already in use; close the program that holds it or change listen.port in {config}. / "
            f"视频转发层端口 {port} 已被占用：请关闭占用该端口的程序，或修改 {config} 中的 listen.port。")
    return host, port


def start(mode: str = "serve", port: int = 8000, web_port: int = 5173, log_level: str = "info",
          video_gateway: Path | None = None) -> int:
    if not 1 <= port <= 65535 or not 1 <= web_port <= 65535:
        raise ValueError("端口必须在 1–65535 之间。")
    if mode not in {"serve", "dev"}:
        raise ValueError("启动模式必须是 serve 或 dev。")
    if mode == "serve" and not (web_root() / "index.html").is_file():
        raise ValueError("Web resources missing; reinstall with pip install -e . or pip install --force-reinstall opendirector. / 缺少前端产物，请重新安装。")
    if mode == "dev" and ROOT is None:
        raise ValueError("Development mode requires an editable source checkout. / 开发模式需要源码安装。")
    workspace = data_root()
    workspace.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, "OPENDIRECTOR_ROOT": str(workspace), "OPENDIRECTOR_API_URL": f"http://127.0.0.1:{port}"}
    source_paths = [str(ROOT / "packages/core/src"), str(ROOT / "apps/api/src")] if ROOT else []
    if environment.get("PYTHONPATH"):
        source_paths.append(environment["PYTHONPATH"])
    environment["PYTHONPATH"] = os.pathsep.join(source_paths)
    processes = []
    try:
        # Fail before spawning anything: a bound port must name the real remedy.
        require_free_port(port, "--port")
        if mode == "dev":
            require_free_port(web_port, "--web-port")
        gateway_config = video_gateway_config(video_gateway, workspace)
        gateway = None
        if gateway_config:
            gateway_host, gateway_port = video_gateway_listen(gateway_config, port)
            gateway = subprocess.Popen([sys.executable, "-m", "opendirector.video_gateway", str(gateway_config), "--log-level", log_level],
                                       cwd=workspace, env=environment)
            processes.append(gateway)
        api = subprocess.Popen([sys.executable, "-m", "opendirector_api.server", "--port", str(port), "--log-level", log_level], cwd=workspace, env=environment)
        processes.append(api)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(600):
            if api.poll() is not None:
                raise RuntimeError("本地 API 启动失败（进程已退出）。请查看上方错误输出；"
                                   "若提示地址已被占用，请用 --port 换一个端口后重试。")
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{port}/api/health", headers={"X-OpenDirector-Request": "1"})
                with opener.open(request, timeout=0.3) as response:
                    if response.status == 200:
                        break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        else:
            raise RuntimeError("等待本地服务启动超时。")
        if gateway:
            for _ in range(300):
                if gateway.poll() is not None:
                    raise RuntimeError("The video gateway failed to start; see the error output above. / 视频转发层启动失败，请查看上方错误输出。")
                if port_in_use(gateway_port, gateway_host):
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("Timed out waiting for the video gateway. / 等待视频转发层启动超时。")
            address = f"[{gateway_host}]" if ":" in gateway_host else gateway_host
            print(f"Video gateway / 视频转发层: http://{address}:{gateway_port}/v1  ({gateway_config})", flush=True)
        if mode == "dev":
            node = shutil.which("node")
            vite = ROOT / "node_modules/vite/bin/vite.js"
            if not node or not vite.is_file():
                raise RuntimeError("未找到 Node.js 或 Vite，请安装 Node.js 并执行 npm ci。")
            # Own the Vite process directly so stopping the launcher cannot leave
            # an npm child serving an obsolete API address in the background.
            command = [node, str(vite), "--host", "127.0.0.1", "--port", str(web_port)]
            processes.append(subprocess.Popen(command, cwd=ROOT, env=environment))
        print(f"OpenDirector: http://127.0.0.1:{web_port if mode == 'dev' else port}  (Ctrl+C 退出)", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(0.3)
        return next((process.returncode for process in processes if process.returncode), 0)
    except KeyboardInterrupt:
        return 0
    except (OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
