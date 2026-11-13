"""Consume the actual Omni endpoint exports without renewing their timestamps."""
import json
from pathlib import Path

import httpx
import pytest

from opendirector.application.model_availability import ModelAvailability, tool_request
from opendirector.domain.omni_capabilities import timestamp
from opendirector.integrations.capability_probe import CapabilityProbe


@pytest.mark.parametrize('name,capability,status,reason', [
    ('wan-i2v', 'video.first_frame', 'available', 'supported'),
    ('wan-vace', 'video.first_frame', 'unavailable', 'input_unsupported'),
    ('seedvr2', 'video.edit', 'unavailable', 'input_unsupported'),
    ('h3-single-t2va', 'video.edit', 'unknown', 'declaration_incomplete'),
])
def test_exported_endpoint_roles(name, capability, status, reason):
    raw = json.loads((Path(__file__).parent / 'fixtures' / 'omni_capabilities' / f'{name}.json').read_text())
    clock = [timestamp(raw['observed_at'])]
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
                            clock=lambda: clock[0], wall_clock=lambda: clock[0])
    config = {'id': 'exported', 'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://fixture/v1',
              'modelId': 'public-primary', 'connectionType': 'self_hosted'}
    try:
        availability = ModelAvailability(None, probe)
        availability.prepare(config)
        request = tool_request(config, capability, actual=True)
        result = availability.decision(config, request)
        assert (result['status'], result['reasonCode']) == (status, reason)
        # A positive/negative role result must actually use the exported facts;
        # after expiry those facts cannot reject or grant this request.
        clock[0] += 30
        assert availability.decision(config, request)['status'] == 'unknown'
    finally:
        probe.close()
