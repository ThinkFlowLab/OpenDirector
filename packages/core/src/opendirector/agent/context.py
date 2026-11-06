"""Shared input contract for SDK, CLI and service-backed runtimes."""
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import JsonValue

from opendirector.infrastructure.local_projects import write_json

RuntimeId = Literal['default', 'opencode', 'codex', 'claude', 'jiuwenswarm', 'deepseek']
AgentEvent = dict[str, JsonValue]


@dataclass(kw_only=True)
class RunContext:
    runtime: RuntimeId
    project_id: UUID
    turn_id: UUID
    session: str
    directory: Path
    config: dict[str, JsonValue] | None
    messages: list[dict[str, JsonValue]]
    selected_skills: list[str]
    model_selections: dict[str, str | None] = field(default_factory=dict)
    conversation_id: UUID | None = None
    thinking: str = 'auto'
    runtime_model: str | None = None
    skills: list[dict[str, str]] = field(default_factory=list)

    def native_session_path(self) -> Path | None:
        if self.conversation_id is None:
            return None
        return self.directory / 'agent-runs' / f'{self.runtime}-sessions' / str(self.conversation_id)

    def native_session(self, selection: dict) -> dict | None:
        directory = self.native_session_path()
        if directory is None or not (directory / 'session.json').is_file():
            return None
        saved = json.loads((directory / 'session.json').read_text(encoding='utf-8'))
        if saved['selection'] == selection and saved['messages'] == len(self.messages) - 1:
            return saved
        return None

    def native_session_id(self, selection: dict) -> str | None:
        saved = self.native_session(selection)
        return saved['sessionId'] if saved else None

    def save_native_session(self, session_id: str, selection: dict, *, work_turn_id: UUID | None = None) -> None:
        directory = self.native_session_path()
        if directory is not None:
            directory.mkdir(parents=True, exist_ok=True)
            write_json(directory / 'session.json', {'sessionId': session_id, 'selection': selection,
                                                    'messages': len(self.messages) + 1,
                                                    'workTurnId': str(work_turn_id) if work_turn_id else None})
