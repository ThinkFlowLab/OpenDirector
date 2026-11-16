"""Local plugin management; native harnesses retain execution permissions."""
import asyncio
from typing import Annotated

from fastapi import APIRouter, Path, Request
from pydantic import BaseModel, ConfigDict, Field

from opendirector.agent.context import RuntimeId
from opendirector.agent.plugins import MAX_ARCHIVE_BYTES, PluginRegistry, failure
from opendirector.domain.plugins import Digest, PluginId


class PluginSource(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    source: str = Field(min_length=1, max_length=4096)


class PluginChange(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    digest: Digest


class PluginEnabled(PluginChange):
    enabled: bool


def plugin_routes(repository):
    router = APIRouter(prefix='/api/plugins')
    registry = PluginRegistry(repository)

    @router.get('')
    def catalog():
        return registry.catalog()

    @router.post('')
    def install(value: PluginSource):
        return registry.install(value.source)

    @router.post('/upload')
    async def upload(request: Request):
        content = bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content) > MAX_ARCHIVE_BYTES:
                raise failure('plugin_too_large', 413)
        return await asyncio.to_thread(registry.install, bytes(content))

    @router.put('/{plugin_id}/runtimes/{runtime}')
    def enable(plugin_id: Annotated[PluginId, Path()], runtime: RuntimeId, value: PluginEnabled):
        return registry.change(plugin_id, value.digest, runtime=runtime, enabled=value.enabled)

    @router.delete('/{plugin_id}')
    def remove(plugin_id: Annotated[PluginId, Path()], value: PluginChange):
        return registry.change(plugin_id, value.digest)

    return router
