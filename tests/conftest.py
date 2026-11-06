"""Bind infrastructure ports before tests construct application services.

Pytest loads this module before importing test modules. Capability markers are
registered here too, so a gate reads the same everywhere and `pytest -ra` always
explains why a case was skipped.
"""
import pytest

from opendirector.wiring import configure_runtime

configure_runtime()


def pytest_configure(config):
    config.addinivalue_line('markers', 'requires_ffmpeg: needs a local FFmpeg and ffprobe')
    config.addinivalue_line('markers', 'requires_posix: needs POSIX filesystem semantics (symlinks, shebang)')
