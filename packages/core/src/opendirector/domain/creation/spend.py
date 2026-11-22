"""Service prices are decimal amounts in their original currency."""
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from .base import Contract, Digest, ObjectVersion, ProjectEntity, digest

Currency = Literal['USD', 'CNY']
Money = Annotated[Decimal, Field(ge=0, max_digits=24, decimal_places=12, allow_inf_nan=False)]
Unit = Literal['request', 'input_character', 'input_second', 'requested_second', 'output_second']


class ConnectionPrice(Contract):
    unit: Unit = Field(description='What the configured service bills for.')
    rate: Money = Field(description='Price for one billing unit.')
    currency: Currency = Field(description='Currency of the service price.')


class PriceLine(Contract):
    operation: str = Field(description='Model operation being priced.')
    modelConfigId: UUID = Field(description='Selected model connection.')
    modelId: str = Field(description='Provider model receiving the request.')
    source: Literal['connection', 'official', 'local', 'unknown'] = Field(description='Origin of the price.')
    sourceVersion: str | None = Field(default=None, description='Price revision or dated official source.')
    price: ConnectionPrice | None = Field(default=None, description='Native unit price, when known.')
    quantity: Money | None = Field(default=None, description='Billing units or bounded maximum for one candidate.')
    amount: Money | None = Field(default=None, description='Estimated amount for this step of one candidate.')


class SpendQuote(Contract):
    count: int = Field(ge=1, le=8, description='Number of fixed candidates in this action.')
    inputFingerprint: Digest = Field(description='Identity of the effective model inputs.')
    lines: tuple[PriceLine, ...] = Field(description='Individual provider calls per candidate, in execution order.')

    def total(self, currency):
        if any(line.amount is None or (line.amount and line.price.currency != currency) for line in self.lines):
            return None
        return sum((line.amount for line in self.lines), Decimal(0)) * self.count

    def fingerprint(self):
        return digest(self)


class SpendPolicy(Contract):
    currency: Currency = Field(default='USD', description='Currency of the project spending limits.')
    threshold: Money | None = Field(default=None, description='Require confirmation strictly above this batch amount.')
    cap: Money | None = Field(default=None, description='Maximum settled and reserved service spend.')


class SpendRequest(ProjectEntity):
    versions: tuple[ObjectVersion, ...] = Field(description='Input object versions fixed when the request was made.')
    quote: SpendQuote = Field(description='Exact batch covered by this request.')
    createdAt: datetime = Field(description='Time the project requested a review.')
    status: Literal['pending', 'accepted', 'cancelled'] = Field(default='pending', description='Human review status.')
    agentRunId: UUID | None = Field(default=None, description='Originating assistant turn.')
    agentCallId: str | None = Field(default=None, description='Originating assistant tool call.')
    decisionId: UUID | None = Field(default=None, description='Durable command that resolved this request.')


class SpendCall(ProjectEntity):
    ownerId: UUID = Field(description='Generation job or media tool task that owns this call.')
    line: PriceLine = Field(description='Original native-currency estimate for this physical call.')
    createdAt: datetime = Field(description='Time the reservation was created.')
    state: Literal['reserved', 'submitted', 'completed', 'released'] = Field(default='reserved', description='State of the provider call.')
    usage: Money | None = Field(default=None, description='Metered units reported for the call.')
    calculated: Money | None = Field(default=None, description='Amount calculated from confirmed usage and the agreed rate.')
    reported: Money | None = Field(default=None, description='Charge explicitly reported by the provider in the line currency.')

    def accounted(self):
        if self.state == 'released':
            return Decimal(0)
        for amount in (self.reported, self.calculated, self.line.amount):
            if amount is not None:
                return amount
        return None


class SpendReview(Contract):
    requestId: UUID = Field(description='Original batch request.')
    fingerprint: Digest = Field(description='Reviewed input and price fingerprint.')
    decision: Literal['approve', 'cancel'] = Field(description='Human decision for this exact action.')
    acceptUnknown: bool = Field(default=False, description='Explicitly accepts this unpriced action with no project cap.')
    newCap: Money | None = Field(default=None, description='Raise the project cap in the same transaction as admission.')


def spend_summary(snapshot):
    policy = snapshot.project.spendPolicy or SpendPolicy()
    settled, held = Decimal(0), Decimal(0)
    missing = 0
    owners = set()
    for call in snapshot.spendCalls:
        owners.add(call.ownerId)
        amount = call.accounted()
        if amount is None or (amount and call.line.price.currency != policy.currency):
            missing += 1
        elif call.state == 'completed' and (call.calculated is not None or call.reported is not None):
            settled += amount
        else:
            held += amount
    legacy = sum(j.execution.kind != 'text' and j.id not in owners for j in snapshot.jobs)
    return dict(policy=policy, settled=settled, held=held, available=None if policy.cap is None else policy.cap-settled-held,
                unknown=missing, legacy=legacy, since=min((c.createdAt for c in snapshot.spendCalls), default=None))


def spend_decision(summary, quote):
    policy = summary['policy']
    amount = quote.total(policy.currency)
    if amount == 0:
        return 'ready'
    if amount is None:
        return 'unpriced' if policy.cap is not None else 'unknown_confirmation' if policy.threshold is not None else 'ready'
    if policy.cap is not None and amount > summary['available']:
        return 'over_cap'
    if policy.threshold is not None and amount > policy.threshold:
        return 'confirmation'
    return 'ready'


# These synchronous retail prices cover every supported output specification
# on the mainland endpoint. A proxy or a different API receives no default.
OFFICIAL_URL = 'https://open.bigmodel.cn/api/paas/v4'
OFFICIAL_SOURCE = 'https://docs.bigmodel.cn/cn/guide/start/pricing#2026-11-22'
OFFICIAL_PRICES = {
    ('openai', 'glm-image', 'image'): ('request', '0.10'),
    ('bigmodel_video', 'cogvideox-3', 'video'): ('request', '1'),
    ('openai', 'glm-tts', 'speech'): ('input_character', '0.0002'),
}


def price_line(config, operation, quantities):
    """Count only units for which the effective request supplies a bound."""
    version = None
    price = None
    if config.get('price') is not None:
        price = ConnectionPrice.model_validate(config['price'])
        source, version = 'connection', digest(price)
    elif config['connectionType'] == 'self_hosted':
        price = ConnectionPrice(unit='request', currency='USD', rate=0)
        source = 'local'
    elif (config['url'].rstrip('/') == OFFICIAL_URL and
          (row := OFFICIAL_PRICES.get((config['protocol'], config['modelId'], operation)))):
        price = ConnectionPrice(unit=row[0], rate=row[1], currency='CNY')
        source, version = 'official', OFFICIAL_SOURCE
    else:
        source = 'unknown'
    quantity = None if price is None else {'request': 1, **quantities}.get(price.unit)
    units = Decimal(str(quantity)) if quantity is not None else None
    amount = None if price is None or units is None else price.rate * units
    if price is not None and price.rate == 0:
        amount = Decimal(0)
    return PriceLine(operation=operation, modelConfigId=config['id'], modelId=config['modelId'],
                     source=source, sourceVersion=version, price=price, quantity=units, amount=amount)
