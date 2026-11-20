"""Prepare the concrete video calls a tool will make, without decoding media."""
from opendirector.integrations.model_adapters import VllmOmniVideo
from opendirector.integrations.vllm_omni import capability_parameters

from .tool_video_recipes import redraw_intervals, reshoot_window


def video_execution(tool, parameters, source, *, adapter, capability):
    if not isinstance(adapter, VllmOmniVideo):
        return None
    if capability == 'video.first_frame' and tool == 'dynamic-poster':
        return {'requests': [capability_parameters(*adapter.video_parameters(5, first_frame=True))]}
    if capability != 'video.edit':
        return None
    duration = source['durationMs'] / 1000
    window = reshoot_window(parameters) if tool == 'video-partial-reshoot' else None
    pieces = redraw_intervals(duration, 4.0, float(adapter.MAX_SECONDS), window)
    requests = [capability_parameters(*adapter.edit_parameters(last - first, source['width'], source['height']))
                for first, last in pieces]
    return {'pieces': pieces, 'requests': requests}
