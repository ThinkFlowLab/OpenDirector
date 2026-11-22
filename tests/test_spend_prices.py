from decimal import Decimal
from uuid import uuid4

from opendirector.domain.creation.spend import OFFICIAL_URL, SpendQuote, price_line


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
