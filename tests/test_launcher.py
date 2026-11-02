"""A bound port must name the real remedy instead of blaming dependencies."""
import importlib.util
from pathlib import Path
import socket

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "opendirector.py"


def launcher():
    spec = importlib.util.spec_from_file_location("opendirector_launcher", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bound_port():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    return listener, listener.getsockname()[1]


def test_port_in_use_detects_a_bound_socket_and_its_release():
    module = launcher()
    listener, port = bound_port()
    try:
        assert module.port_in_use(port) is True
    finally:
        listener.close()
    assert module.port_in_use(port) is False


def test_bound_port_names_the_switch_and_a_free_alternative():
    module = launcher()
    listener, port = bound_port()
    try:
        try:
            module.require_free_port(port, "--port")
        except RuntimeError as error:
            message = str(error)
        else:
            raise AssertionError("a bound port must fail before spawning anything")
    finally:
        listener.close()
    assert f"端口 {port} 已被占用" in message
    assert "--port" in message
    assert str(module.suggested_port(port)) in message


def test_free_port_passes_without_raising():
    module = launcher()
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    free = probe.getsockname()[1]
    probe.close()
    module.require_free_port(free, "--port")
