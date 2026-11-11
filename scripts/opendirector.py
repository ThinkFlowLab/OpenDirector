"""Unified OpenDirector entry point for startup and project commands."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
common = root / ".git"
if common.exists():
    common = Path(subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True).strip())
for location in (root, common.parent):
    python = location / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if python.is_file():
        if Path(sys.executable).parent != python.parent:
            if os.name == "nt":
                # The Windows CRT execv does not quote arguments containing
                # spaces. Let subprocess build the native command line and
                # propagate the child's status to the caller.
                raise SystemExit(subprocess.call([str(python), *sys.argv]))
            os.execv(python, [str(python), *sys.argv])
        break
sys.path.insert(0, str(root / "packages/core/src"))
from opendirector.cli import main

if __name__ == "__main__":
    main()
