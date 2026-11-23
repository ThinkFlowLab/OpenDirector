"""Download bundled example canvases through the local Host."""

import json
from importlib.resources import files

import httpx
from fastapi import APIRouter
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

router = APIRouter()
_catalog = json.loads(files(__package__).joinpath("example-canvases.json").read_text(encoding="utf-8"))
_urls = {item["id"]: item["url"] for item in _catalog["items"]}
_hosts = {"lz.qaiu.top", "zip3.webgetstore.com"}
_max_bytes = 256 * 1024 * 1024


@router.get("/api/example-canvases/{example_id}/download")
async def download_example(example_id: str):
    source = _urls.get(example_id)
    if source is None:
        return Response(status_code=404)

    client = httpx.AsyncClient(timeout=20)
    upstream = None

    async def close():
        try:
            if upstream is not None:
                await upstream.aclose()
        finally:
            await client.aclose()

    try:
        url = httpx.URL(source)
        for _ in range(5):
            if (url.scheme != "https" or url.host not in _hosts or url.userinfo
                    or url.port not in (None, 443)):
                raise ValueError("Invalid example download destination")
            request = client.build_request("GET", url, headers={"Accept-Encoding": "identity"})
            upstream = await client.send(request, stream=True)
            if not upstream.is_redirect:
                break
            url = url.join(upstream.headers["location"])
            await upstream.aclose()
        else:
            raise ValueError("Too many example download redirects")

        upstream.raise_for_status()
        if upstream.headers.get("content-encoding", "identity").lower() != "identity":
            raise ValueError("Unexpected example archive encoding")
        length = upstream.headers.get("content-length")
        if length is not None and not 0 < int(length) <= _max_bytes:
            raise ValueError("Invalid example archive size")
    except (httpx.HTTPError, ValueError, KeyError):
        await close()
        return Response(status_code=502)
    except BaseException:
        await close()
        raise

    async def body():
        total = 0
        try:
            async for chunk in upstream.aiter_raw():
                total += len(chunk)
                if total > _max_bytes:
                    raise ValueError("Example archive exceeds download limit")
                yield chunk
        finally:
            await close()

    headers = {"Cache-Control": "no-store"}
    if length is not None:
        headers["Content-Length"] = length
        # Electron strips Content-Length when it reconstructs the streamed response.
        headers["X-OpenDirector-Archive-Bytes"] = length
    return StreamingResponse(body(), media_type="application/octet-stream", headers=headers,
                             background=BackgroundTask(close))
