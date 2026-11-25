"""Stable identifiers for Agent runtimes shared across application layers."""

from typing import Literal

RuntimeId = Literal['default', 'opencode', 'codex', 'claude', 'jiuwenswarm', 'deepseek']
