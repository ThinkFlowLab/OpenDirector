"""Boundary between application services and infrastructure adapters.

Dependencies point inward:

- ``domain`` depends on neither application, ports, nor infrastructure.
- ``ports`` defines the abstractions application services call. It may depend
  on ``domain`` and must not depend on ``application`` or ``infrastructure``.
- ``application`` depends on ``domain`` and ``ports``. It must not import
  ``infrastructure`` or the composition root.
- ``infrastructure`` implements the ports and may depend on ``domain`` and
  ``ports``. It must not import ``application``.
- ``wiring`` is the composition root. Process entrypoints call it to bind
  concrete adapters and command dispatch. Neither application nor
  infrastructure imports it.

Command routing lives in ``application.creation_commands``. Project storage
commits results; it does not choose which service handles a command.
"""
