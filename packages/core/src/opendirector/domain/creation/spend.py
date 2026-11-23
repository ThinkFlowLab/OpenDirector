"""Service prices are decimal amounts in their original currency."""
from datetime import datetime
from decimal import Decimal, ROUND_CEILING, localcontext
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, JsonValue

from .base import Contract, Digest, ObjectVersion, ProjectEntity, digest

Currency = Literal['USD', 'CNY']
Amount = Annotated[Decimal, Field(ge=0, allow_inf_nan=False)]
MONEY_DIGITS = 24
MONEY_PLACES = 12
Money = Annotated[Decimal, Field(ge=0, max_digits=MONEY_DIGITS, decimal_places=MONEY_PLACES, allow_inf_nan=False)]
Unit = Literal['request', 'input_character', 'input_second', 'requested_second', 'output_second']


def spend_math():
    # Rate × quantity needs up to 48 digits. Another 24 carry digits cover
    # every call in a project, including an eight-candidate batch.
    return localcontext(prec=3 * MONEY_DIGITS)


def service_charge(rate, quantity):
    with spend_math():
        return rate * quantity


class ConnectionPrice(Contract):
    unit: Unit = Field(description='What the configured service bills for.')
    rate: Money = Field(description='Price for one billing unit.')
    currency: Currency = Field(description='Currency of the service price.')


class PriceLine(Contract):
    operation: str = Field(description='Model operation being priced.')
    modelConfigId: UUID = Field(description='Selected model connection.')
    modelId: str = Field(description='Provider model receiving the request.')
    providerUrl: str | None = Field(default=None, exclude_if=lambda v: v is None, description='Endpoint for this quoted connection.')
    source: Literal['connection', 'official', 'local', 'unknown'] = Field(description='Origin of the price.')
    sourceUrl: str | None = Field(default=None, exclude_if=lambda v: v is None, description='Published source for an official price.')
    sourceVersion: str | None = Field(default=None, description='Price revision or dated official source.')
    price: ConnectionPrice | None = Field(default=None, description='Native unit price, when known.')
    quantityBasis: Literal['fixed', 'maximum'] = Field(default='fixed', exclude_if=lambda v: v == 'fixed', description='Whether the quoted quantity is an upper bound.')
    quantity: Money | None = Field(default=None, description='Billing units or bounded maximum for one candidate.')
    amount: Amount | None = Field(default=None, description='Estimated amount for this step of one candidate.')


class SpendQuote(Contract):
    fromUpstream: bool = Field(default=False, exclude_if=lambda v: not v, description='Inputs are newly resolved upstream results.')
    candidates: int | None = Field(default=None, exclude_if=lambda v: v is None, description='Total candidates across distinct group members.')
    skipped: tuple[UUID, ...] = Field(default=(), exclude_if=lambda v: not v, description='Workflow items blocked by a failed dependency or reference cycle.')
    deferred: tuple[UUID, ...] = Field(default=(), exclude_if=lambda v: not v, description='Workflow items awaiting upstream inputs.')
    count: int = Field(ge=1, le=8, description='Number of fixed candidates in this action.')
    inputFingerprint: Digest = Field(description='Identity of the effective model inputs.')
    lines: tuple[PriceLine, ...] = Field(description='Individual provider calls per candidate, in execution order.')

    def total(self, currency):
        if any(line.amount is None or (line.amount and line.price.currency != currency) for line in self.lines):
            return None
        with spend_math():
            return sum((line.amount for line in self.lines), Decimal(0)) * self.count

    def subtotals(self):
        currencies = {line.price.currency for line in self.lines if line.price is not None and line.amount is not None}
        with spend_math():
            return {c: sum((line.amount for line in self.lines if line.price and line.price.currency == c and line.amount is not None), Decimal(0)) * self.count for c in sorted(currencies)}

    def fingerprint(self):
        return digest(self)


class SpendPolicy(Contract):
    currency: Currency = Field(default='USD', description='Currency of the project spending limits.')
    threshold: Money | None = Field(default=None, description='Require confirmation strictly above this batch amount.')
    cap: Money | None = Field(default=None, description='Maximum settled and reserved service spend.')


class ToolSpendInput(Contract):
    request: dict[str, JsonValue] = Field(description='Validated media tool submission, including its stable task ID.')


class SpendRequest(ProjectEntity):
    currency: Currency | None = Field(default=None, exclude_if=lambda v: v is None, description='Project currency when this quote was requested.')
    specId: UUID | None = Field(default=None, exclude_if=lambda v: v is None, description='Fixed generation specification for a candidate batch.')
    batchId: UUID | None = Field(default=None, exclude_if=lambda v: v is None, description='Canvas batch identity for member validation.')
    workflowId: UUID | None = Field(default=None, exclude_if=lambda v: v is None, description='Original group action owning this decision.')
    groupItems: tuple[UUID, ...] = Field(default=(), exclude_if=lambda v: not v, description='Fixed workflow items included in this decision.')
    toolTask: dict[str, JsonValue] | None = Field(default=None, exclude_if=lambda v: v is None,
        description='Frozen media tool dispatch, without credentials. The project journal owns its acceptance.')
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
    usageSource: Literal['execution', 'provider', 'media'] | None = Field(default=None, description='Origin of the quantity used for settlement.')
    calculated: Amount | None = Field(default=None, description='Amount calculated from confirmed usage and the agreed rate.')
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


class SpendObservation(Contract):
    callId: UUID = Field(description='Stable physical call receiving evidence.')
    state: Literal['submitted', 'completed', 'released'] = Field(description='Observed execution state.')
    unit: Unit | None = Field(default=None, description='Unit of observed provider usage.')
    usage: Money | None = Field(default=None, description='Provider units or measured output length.')
    reported: Money | None = Field(default=None, description='Verified provider amount in the quoted currency.')
    evidence: Literal['execution', 'provider', 'media'] = Field(default='execution', description='Source of the observation.')


def observed_call(call, observation):
    """Repeated transfer and download events cannot charge or release a call twice."""
    state = observation.state
    if ((state in {'released', 'submitted'} and call.state != 'reserved') or
            (call.state == 'released' and observation.evidence != 'provider')):
        return call
    changes = dict(state=state)
    price = call.line.price
    if state == 'completed' and price is not None:
        if observation.reported is not None:
            changes['reported'] = observation.reported
        if observation.unit == price.unit and observation.usage is not None:
            if call.usageSource != 'provider' or observation.evidence == 'provider':
                changes.update(usage=observation.usage, usageSource=observation.evidence, calculated=service_charge(price.rate, observation.usage))
        elif call.calculated is None and call.line.quantityBasis == 'fixed' and price.unit != 'output_second' and call.line.quantity is not None:
            changes.update(usage=call.line.quantity, usageSource='execution', calculated=call.line.amount)
    edited = call.model_copy(update=changes)
    return call if edited == call else edited.model_copy(update={'revision': call.revision + 1})


def call_totals(calls, currency):
    settled, held, missing = Decimal(0), Decimal(0), 0
    with spend_math():
        for call in calls:
            amount = call.accounted()
            if amount is None or (amount and call.line.price.currency != currency):
                missing += 1
            elif call.state == 'completed' and (call.calculated is not None or call.reported is not None):
                settled += amount
            else:
                held += amount
    return dict(settled=settled, held=held, unknown=missing)


def spend_summary(snapshot):
    policy = snapshot.project.spendPolicy or SpendPolicy()
    totals = call_totals(snapshot.spendCalls, policy.currency)
    owners = {call.ownerId for call in snapshot.spendCalls}
    with spend_math():
        available = None if policy.cap is None or totals['unknown'] else policy.cap - totals['settled'] - totals['held']
    return dict(policy=policy, **totals, available=available,
        legacy=sum(j.execution.kind != 'text' and j.id not in owners for j in snapshot.jobs),
        since=min((c.createdAt for c in snapshot.spendCalls), default=None))


def spend_decision(summary, quote):
    policy = summary['policy']
    amount = quote.total(policy.currency)
    controlled = policy.cap is not None or policy.threshold is not None
    if amount == 0:
        return 'upstream_confirmation' if controlled and quote.deferred else 'ready'
    if amount is None:
        return 'unpriced' if policy.cap is not None else 'unknown_confirmation' if policy.threshold is not None else 'ready'
    if policy.cap is not None and summary['unknown']:
        return 'prior_unknown'
    if policy.cap is not None and amount > summary['available']:
        return 'over_cap'
    if controlled and quote.deferred:
        return 'upstream_confirmation'
    if controlled and quote.fromUpstream:
        return 'confirmation'
    if policy.threshold is not None and amount > policy.threshold:
        return 'confirmation'
    return 'ready'


def cap_adjustment(current_cap, available, amount):
    """Return the shortfall and the smallest policy cap that covers this batch."""
    with spend_math():
        missing = amount - available
        required = current_cap + missing
        upper_bound = Decimal(10) ** (MONEY_DIGITS - MONEY_PLACES)
        if required >= upper_bound:
            return missing, None
        if required.as_tuple().exponent < -MONEY_PLACES:
            required = required.quantize(Decimal(1).scaleb(-MONEY_PLACES), rounding=ROUND_CEILING)
        return missing, required if required < upper_bound else None


# These synchronous retail prices cover every supported output specification
# on the mainland endpoint. A proxy or a different API receives no default.
OFFICIAL_URL = 'https://open.bigmodel.cn/api/paas/v4'
OFFICIAL_SOURCE = 'https://docs.bigmodel.cn/cn/guide/start/pricing'
OFFICIAL_PRICES = {
    ('openai', 'glm-image', 'image'): ('request', '0.10'),
    ('bigmodel_video', 'cogvideox-3', 'video'): ('request', '1'),
    ('openai', 'glm-tts', 'speech'): ('input_character', '0.0002'),
}


def video_units(fields, fallback_seconds=None):
    """Frame-based APIs receive their aligned frame count, including any padding."""
    frames, fps = fields.get('num_frames'), fields.get('fps')
    if frames and fps:
        seconds = (Decimal(frames) / Decimal(str(fps))).quantize(Decimal('0.000000000001'), rounding=ROUND_CEILING)
    else:
        seconds = fields.get('duration', fallback_seconds)
    return {} if seconds is None else {'requested_second': seconds, 'output_second': seconds}


def price_line(config, operation, quantities, *, bounded=()):
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
        source, version = 'official', '2026-11-22'
    else:
        source = 'unknown'
    quantity = None if price is None else {'request': 1, **quantities}.get(price.unit)
    units = Decimal(str(quantity)) if quantity is not None else None
    amount = None if price is None or units is None else service_charge(price.rate, units)
    if price is not None and price.rate == 0:
        amount = Decimal(0)
    return PriceLine(operation=operation, modelConfigId=config['id'], modelId=config['modelId'], providerUrl=config.get('url'),
                     source=source, sourceVersion=version, sourceUrl=OFFICIAL_SOURCE if source == 'official' else None, price=price,
                     quantityBasis='maximum' if price and (price.unit == 'output_second' or price.unit in bounded) else 'fixed', quantity=units, amount=amount)
