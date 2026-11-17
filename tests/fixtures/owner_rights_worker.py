"""Real-process lease fixture; no model, ACL repair script, or API mock."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import time

from opendirector.agent import owner_rights as rights


async def main(work, status):
    async with rights.native_owner_access(work):
        api = rights._Windows()
        status.write_text(json.dumps({'temp': tempfile.gettempdir(),
            'coordinator': str(rights._coordination_directory(api))}), encoding='utf-8')
        deadline = time.monotonic() + 20
        while not status.with_suffix('.release').exists():
            if time.monotonic() >= deadline: raise TimeoutError('Owner lease fixture release timed out')
            await asyncio.sleep(.025)
    status.with_suffix('.closed').write_text('closed', encoding='utf-8')


if __name__ == '__main__':
    asyncio.run(main(*(Path(value) for value in sys.argv[1:])))
