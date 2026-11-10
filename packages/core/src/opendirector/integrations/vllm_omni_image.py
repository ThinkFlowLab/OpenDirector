"""Self-hosted vLLM-Omni image models (Z-Image-Turbo, Qwen-Image-2.1) for canvas nodes.

Reference documents are inlined as text. Z-Image-Turbo accepts one input image;
Qwen-Image-2.1 accepts up to four condition images. Automatic
output uses H3's 16:9 canvas; explicit output uses the frozen request dimensions.
The model API itself is reached through the capability adapter.
"""

import asyncio
import base64

from opendirector.domain.capabilities import ImageRequest
from opendirector.domain.projects import ProjectError
from opendirector.integrations.generation_errors import protocol_failure
from opendirector.integrations.model_adapters import adapter_for
from opendirector.integrations.reference_inputs import generation_references

WIDTH, HEIGHT = 1344, 768


class VllmOmniImageGeneration:
    def __init__(self, store, transport=None, poll_interval=3):
        self.store, self.transport = store, transport

    def validate(self, kind, config):
        if kind != 'image':
            raise ProjectError('vLLM-Omni 图片模型只用于图片生成。', 409)

    def prepare_inputs(self, project_id, node, config, *, complete=True):
        prepared = generation_references(self.store, {**node, 'projectId': project_id}, config, complete=complete)
        return {'profile': prepared['rules']['profile'], 'references': prepared['manifest']}

    async def generate(self, config, task, submitted, *, result_ready=None):
        prepared = await asyncio.to_thread(generation_references, self.store, task, config)
        references = tuple(base64.b64decode(uri.split(',', 1)[1]) for uri in prepared['images'])
        adapter = adapter_for(config, self.transport)
        size = task.get('parameters', {}).get('size', '')
        width, height = map(int, size.split('x')) if 'x' in size else (WIDTH, HEIGHT)
        result = await adapter.image(config, ImageRequest(prompt=prepared['prompt'], width=width, height=height,
                                                          image=references[0] if references else None, references=references[1:]))
        if result.suffix != 'png':
            raise protocol_failure('submit')
        return 'png', result.data

    async def resume_result(self, config, suffix, url):
        # Results arrive inline with the response; there is never a URL to resume.
        raise protocol_failure('download')

    async def cancel(self, config, external_id):
        # Requests are synchronous and never receive an external task ID.
        return None
