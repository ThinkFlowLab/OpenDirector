"""Bind infrastructure ports before tests construct application services.

Pytest loads this module before importing test modules. Capability markers are
registered here too, so a gate reads the same everywhere and `pytest -ra` always
explains why a case was skipped.
"""
import pytest
import socket

pytest_plugins = ['ci_profile']

from opendirector.wiring import configure_runtime

configure_runtime()


@pytest.fixture
def public_cdn(monkeypatch):
    """Mocked downloads still validate DNS, without depending on public resolvers."""
    lookup = socket.getaddrinfo

    def resolve(host, port, *args, **kwargs):
        if host in {'cdn.test', 'cdn.example'}:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', port))]
        return lookup(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, 'getaddrinfo', resolve)


def pytest_configure(config):
    config.addinivalue_line('markers', 'requires_ffmpeg: needs a local FFmpeg and ffprobe')
    config.addinivalue_line('markers', 'requires_posix: needs POSIX filesystem semantics (symlinks, shebang)')
