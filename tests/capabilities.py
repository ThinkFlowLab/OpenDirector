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


def _gated(marker, skip):
    """Attach the capability mark and its skip condition, in that order.

    `pytest.mark.x(pytest.mark.skipif(...))` keeps only one of the two, so the
    skip is applied to the function first and the capability mark on the result:
    `-m requires_posix` then selects the case and the skip explains why it cannot
    run on this machine.
    """
    def decorate(function):
        return marker(skip(function))
    return decorate


def requires_ffmpeg():
    """The test shells out to FFmpeg and ffprobe to build or inspect real media."""
    missing = [name for name in ('ffmpeg', 'ffprobe') if not shutil.which(name)]
    return _gated(pytest.mark.requires_ffmpeg,
                  pytest.mark.skipif(bool(missing), reason=f'requires local {", ".join(missing)}'))


def requires_posix():
    """The test needs symlinks, shebang execution or POSIX permission semantics."""
    return _gated(pytest.mark.requires_posix,
                  pytest.mark.skipif(os.name == 'nt', reason='requires POSIX filesystem semantics'))
