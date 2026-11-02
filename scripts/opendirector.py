"""Run the local API and, in development, Vite from any working directory."""

import argparse
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def port_in_use(port: int) -> bool:
    """True when something already accepts connections on the local port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.25)
        return probe.connect_ex(("127.0.0.1", port)) == 0


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


def main():
    parser = argparse.ArgumentParser(description="启动 OpenDirector 本地应用")
    parser.add_argument("mode", choices=("dev", "serve"), nargs="?", default="serve")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--web-port", type=int, default=5173)
    parser.add_argument("--log-level", choices=("debug", "info", "warning", "error", "critical"), default="info")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.web_port <= 65535:
        parser.error("端口必须在 1–65535 之间。")
    if args.mode == "serve" and not (ROOT / "dist/index.html").is_file():
        parser.error("请先运行 npm run build。")
    environment = {**os.environ, "OPENDIRECTOR_ROOT": str(ROOT), "OPENDIRECTOR_API_URL": f"http://127.0.0.1:{args.port}"}
    processes = []
    try:
        # Fail before spawning anything: a bound port must name the real remedy.
        require_free_port(args.port, "--port")
        if args.mode == "dev":
            require_free_port(args.web_port, "--web-port")
        api = subprocess.Popen([sys.executable, "-m", "opendirector_api.server", "--port", str(args.port), "--log-level", args.log_level], cwd=ROOT, env=environment)
        processes.append(api)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            if api.poll() is not None:
                raise RuntimeError("本地 API 启动失败（进程已退出）。请查看上方错误输出；"
                                   "若提示地址已被占用，请用 --port 换一个端口后重试。")
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{args.port}/api/health", headers={"X-OpenDirector-Request": "1"})
                with opener.open(request, timeout=0.3) as response:
                    if response.status == 200:
                        break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        else:
            raise RuntimeError("等待本地服务启动超时。")
        if args.mode == "dev":
            node = shutil.which("node")
            vite = ROOT / "node_modules/vite/bin/vite.js"
            if not node or not vite.is_file():
                raise RuntimeError("未找到 Node.js 或 Vite，请安装 Node.js 并执行 npm ci。")
            # Own the Vite process directly so stopping the launcher cannot leave
            # an npm child serving an obsolete API address in the background.
            command = [node, str(vite), "--host", "127.0.0.1", "--port", str(args.web_port)]
            processes.append(subprocess.Popen(command, cwd=ROOT, env=environment))
        print(f"OpenDirector: http://127.0.0.1:{args.web_port if args.mode == 'dev' else args.port}  (Ctrl+C 退出)", flush=True)
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


if __name__ == "__main__":
    raise SystemExit(main())
