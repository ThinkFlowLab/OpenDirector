"""Application-owned command dispatch, invoked by project storage."""
from typing import Protocol


class PortsNotConfigured(RuntimeError):
    """Raised when a command runs before the composition root binds dispatch."""


class CommandDispatcher(Protocol):
    def execute(self, projects, command, *, session=None, source='ui', imported_from=None):
        """Route one command and return its receipt."""


_dispatcher: CommandDispatcher | None = None


def register_command_dispatcher(dispatcher: CommandDispatcher) -> None:
    global _dispatcher
    _dispatcher = dispatcher


def command_dispatcher() -> CommandDispatcher:
    if _dispatcher is None:
        raise PortsNotConfigured(
            'Creation command dispatch is not configured. Call opendirector.wiring.configure_runtime().')
    return _dispatcher
