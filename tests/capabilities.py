"""Ambient capabilities a test needs, declared instead of probed inline.

Tests that depend on an installed binary or on POSIX-only filesystem semantics
used to call `shutil.which` / `os.name` themselves, so the same requirement
appeared in a dozen spellings and a missing capability surfaced as a red failure
that depended on which machine ran the suite. Declaring it here keeps one
spelling and lets pytest report a visible skip with a reason.
"""
import os
import shutil

import pytest


def requires_ffmpeg():
    """The test shells out to FFmpeg and ffprobe to build or inspect real media."""
    missing = [name for name in ('ffmpeg', 'ffprobe') if not shutil.which(name)]
    return pytest.mark.skipif(bool(missing), reason=f'requires local {", ".join(missing)}')


def requires_posix():
    """The test needs symlinks, shebang execution or POSIX permission semantics."""
    return pytest.mark.skipif(os.name == 'nt', reason='requires POSIX filesystem semantics')
