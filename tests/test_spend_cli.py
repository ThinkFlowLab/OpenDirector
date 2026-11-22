import json
from decimal import Decimal
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from generation_helpers import command, new_project, policy
from opendirector import cli
from opendirector.application.creation_spend import save_policy
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


def test_standalone_cli_quotes_submits_and_returns_the_local_review_link(tmp_path, monkeypatch):
    store, pid, session = project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    model = configs.save('image', 'http://fixture.invalid/v1', 'fixture', '', connection_type='self_hosted', auth_mode='none')
    configs.set_price(model['id'], dict(unit='request', rate='.40', currency='USD'))
    draft = command(project, model, parameters={'size': '1024x1024'})
    controls = policy(store, pid, threshold='1')
    store.commit(controls, lambda before: save_policy(before, controls.payload), session=session)
    api = TestClient(create_app(store.local))
    original = httpx.Client
    def forward(request):
        response = api.request(request.method, request.url.path, headers=dict(request.headers), content=request.read())
        return httpx.Response(response.status_code, json=response.json())
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(forward)))
    monkeypatch.delenv('OPENDIRECTOR_AGENT_SOCKET', raising=False)
    monkeypatch.delenv('OPENDIRECTOR_AGENT_HOST', raising=False)
    def invoke(args, stdin=None):
        result = CliRunner().invoke(cli.app, ['--url', 'http://localhost:18188', '--project', str(pid), '--session', session, *args],
                                    input=json.dumps(stdin) if stdin else None)
        assert result.exit_code == 0, (result.output, result.exception)
        return json.loads(result.output)
    quote = invoke(['query', 'generation.quote', '--file', '-'], {'specId':str(draft.payload.specId), 'count':3})
    assert Decimal(quote['amount']) == Decimal('1.20')
    body = {'expectedVersions':[v.model_dump(mode='json') for v in draft.expectedVersions],
            'payload':{**draft.payload.model_dump(mode='json'), 'count':3}}
    args = ['--operation-id', str(uuid4()), 'generation', 'submit', '--file', '-']
    waiting = invoke(args, body)
    assert waiting == invoke(args, body)
    assert waiting['reviewUrl'] == f'http://localhost:18188/ai-tool/ai-canvas/{pid}?spendReview={waiting["spendRequestId"]}'
    status = invoke(['query', 'spend.status'])
    assert len(status['pending']) == 1 and Decimal(status['held']) == 0 and not store.snapshot(pid).jobs
    denied = api.post(f'/api/creation/projects/{pid}/commands', headers={'X-OpenDirector-Request':'1', 'X-OpenDirector-Session':session},
        json=controls.model_copy(update={'commandId': uuid4()}).model_dump(mode='json'))
    assert denied.status_code == 403
