from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

import pytest

from opendirector.application.creation_spend import quote_view, review_status
from opendirector.domain.creation.project import Project, ProjectSnapshot
from opendirector.domain.creation.spend import OFFICIAL_URL, SpendCall, SpendObservation, SpendPolicy, SpendQuote, cap_adjustment, observed_call, price_line, spend_decision


def test_connection_price_takes_precedence_and_an_alias_is_unpriced():
    config = dict(id=uuid4(), connectionType='api', url=OFFICIAL_URL, protocol='openai', modelId='glm-image')
    assert price_line(config, 'image', {}).amount == Decimal('0.10')
    mirror = dict(config, url='https://proxy.invalid/v1')
    assert price_line(mirror, 'image', {}).amount is None
    custom = dict(mirror, price=dict(unit='request', rate='0.40', currency='USD'))
    quote = SpendQuote(count=3, inputFingerprint='0' * 64, lines=[price_line(custom, 'image', {})])
    assert quote.total('USD') == Decimal('1.20')
    assert quote.total('CNY') is None
    assert price_line(dict(custom, connectionType='self_hosted'), 'image', {}).amount == Decimal('0.40')
    assert price_line(dict(mirror, connectionType='self_hosted'), 'image', {}).amount == 0


def test_fractional_recording_cost_preserves_a_valid_subcent_rate():
    config = dict(id=uuid4(), modelId='score', price=dict(unit='input_second', rate='0.000000000001', currency='USD'))
    assert price_line(config, 'score', {'input_second': Decimal('3.001')}).amount == Decimal('0.000000000003001')


def test_suggested_limit_rounds_up_only_if_the_policy_requires_it():
    assert cap_adjustment(Decimal('2.00'), Decimal('0.80'), Decimal('1.20')) == (Decimal('0.40'), Decimal('2.40'))
    assert cap_adjustment(Decimal(0), Decimal(0), Decimal('3.001e-12'))[1] == Decimal('4e-12')
    assert cap_adjustment(Decimal(0), Decimal('-10000'), Decimal('1e-24')) == (
        Decimal('10000.000000000000000000000001'), Decimal('10000.000000000001'))
    largest = SpendPolicy(cap='999999999999.999999999999').cap
    assert cap_adjustment(largest - Decimal('1e-12'), Decimal(0), Decimal('1e-24'))[1] == largest
    assert cap_adjustment(largest, Decimal(0), Decimal('1e-24'))[1] is None
    assert cap_adjustment(Decimal(0), Decimal(0), Decimal('1e28'))[1] is None


@pytest.mark.parametrize('state,field', [('completed', 'settled'), ('reserved', 'held')])
def test_preflight_and_review_retain_tiny_charges_in_the_existing_balance(state, field):
    project = Project(id=uuid4(), name='Budget', spendPolicy=SpendPolicy(cap='10000'))
    config = dict(id=uuid4(), modelId='music', price=dict(unit='output_second', rate='1e-12', currency='USD'))
    tiny = price_line(config, 'music', {'output_second': '1e-12'})
    large = price_line(dict(config, price=dict(unit='request', rate='10000', currency='USD')), 'image', {})
    batch = SpendQuote(count=3, inputFingerprint='0' * 64, lines=[large, tiny])
    assert batch.total('USD') == Decimal('30000.000000000000000000000003')
    assert batch.subtotals() == {'USD': batch.total('USD')}
    at = datetime.now(timezone.utc)
    calls = [SpendCall(id=uuid4(), projectId=project.id, ownerId=uuid4(), line=line, state=state,
                       calculated=line.amount if state == 'completed' else None, createdAt=at) for line in (large, tiny)]
    next_batch = SpendQuote(count=1, inputFingerprint='1' * 64, lines=[price_line(config, 'music', {'output_second': 1})])
    snapshot = ProjectSnapshot(project=project, spendCalls=calls, spendRequests=[
        dict(id=uuid4(), projectId=project.id, quote=next_batch, versions=[], createdAt=at)])
    summary = review_status(snapshot)
    assert summary[field] == Decimal('10000.000000000000000000000001')
    assert summary['available'] == Decimal('-1e-24')
    assert quote_view(snapshot, next_batch)['projectAfter'] == Decimal('10000.000000000001000000000001')
    pending = summary['pending'][0]
    assert pending['shortfall'] == Decimal('1.000000000001e-12')
    assert pending['suggestedCap'] == Decimal('10000.000000000002')
    raised = snapshot.model_copy(update={'project': project.model_copy(update={'spendPolicy': SpendPolicy(cap=pending['suggestedCap'])})})
    assert quote_view(raised, next_batch)['reason'] == 'ready'


def test_estimate_and_confirmed_usage_agree_on_a_full_precision_product():
    value = Decimal('999999999999.999999999999')
    expected = Decimal('999999999999999999999998.000000000000000000000001')
    config = dict(id=uuid4(), modelId='music', price=dict(unit='output_second', rate=value, currency='USD'))
    line = price_line(config, 'music', {'output_second': value})
    assert line.amount == expected
    call = SpendCall(id=uuid4(), projectId=uuid4(), ownerId=uuid4(), createdAt=datetime.now(timezone.utc), line=line)
    actual = SpendObservation(callId=call.id, state='completed', unit='output_second', usage=value)
    assert observed_call(call, actual).calculated == expected


def test_missing_metered_quantity_is_unknown_even_with_a_price():
    config = dict(id=uuid4(), modelId='speech', price=dict(unit='output_second', rate='0.01', currency='USD'))
    assert price_line(config, 'speech', {}).amount is None


def test_prior_unpriced_calls_explain_why_a_known_charge_cannot_use_the_cap():
    model = dict(id=uuid4(), modelId='image', price=dict(unit='request', rate='.4', currency='USD'))
    batch = SpendQuote(count=1, inputFingerprint='0' * 64, lines=[price_line(model, 'image', {})])
    assert spend_decision(dict(policy=SpendPolicy(cap='4'), unknown=1, available=Decimal(4)), batch) == 'prior_unknown'


def test_output_usage_and_late_provider_charge_replace_only_the_same_call():
    model = dict(id=uuid4(), modelId='music', price=dict(unit='output_second', rate='0.02', currency='USD'))
    call = SpendCall(id=uuid4(), projectId=uuid4(), ownerId=uuid4(), createdAt=datetime.now(timezone.utc),
                     line=price_line(model, 'music', {'output_second': 22}))
    def observation(**facts):
        return SpendObservation(callId=call.id, state='completed', **facts)
    measured = observed_call(call, observation(unit='output_second', usage=18, evidence='media'))
    assert measured.line.amount == Decimal('0.44') and measured.calculated == Decimal('0.36')
    reported = observation(unit='output_second', usage=18, evidence='provider', reported='0.35')
    corrected = observed_call(measured, reported)
    assert corrected.usageSource == 'provider' and corrected.accounted() == Decimal('0.35')
    assert observed_call(corrected, reported) == observed_call(corrected, observation(unit='output_second', usage=19, evidence='media')) == corrected
