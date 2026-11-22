from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from opendirector.domain.creation.spend import OFFICIAL_URL, SpendCall, SpendObservation, SpendPolicy, SpendQuote, observed_call, price_line, spend_decision


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
