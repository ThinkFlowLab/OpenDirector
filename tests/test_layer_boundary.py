"""The composition root binds dispatch without an application/infrastructure import cycle."""
from opendirector.application.creation_commands import CreationCommands
from opendirector.ports.dispatch import command_dispatcher
from opendirector.ports.gateway import gateway
from opendirector.wiring import InfrastructureGateway, configure_runtime


def test_runtime_binding_uses_application_dispatch():
    ports = configure_runtime()
    assert isinstance(ports, InfrastructureGateway)
    assert gateway() is ports
    assert isinstance(command_dispatcher(), CreationCommands)
