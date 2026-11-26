"""Typed input and deterministic ordering for a full-source video run."""

from collections import defaultdict
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from .assets import AssetRef
from .base import Contract, Identifier, PositiveInt

SourceFrame = Annotated[int, Field(strict=True, ge=0)]
GuideFrame = Annotated[int, Field(strict=True, ge=0, le=359)]


class SegmentRunAnchor(Contract):
    kind: Literal['anchor'] = Field(description='One independent generation anchor in the declared source shot.')


class SegmentRunContinuation(Contract):
    kind: Literal['continuation'] = Field(description='Generation requires the selected upstream result as a guide.')
    upstreamItemId: UUID = Field(description='Generation node providing the raw guide frames.')
    sourceFrames: tuple[GuideFrame, GuideFrame] = Field(
        description='Two distinct indices into the raw upstream result for destination frames 0 and 21, in that order.')

    @model_validator(mode='after')
    def distinct_frames(self):
        if self.sourceFrames[0] == self.sourceFrames[1]:
            raise ValueError('Run continuation requires two distinct guide frames.')
        return self


class SegmentRunInterval(Contract):
    sourceStart: SourceFrame = Field(description='First covered frame in the normalized working source.')
    sourceEnd: PositiveInt = Field(description='Exclusive end of the covered interval in the normalized working source.')

    @model_validator(mode='after')
    def nonempty(self):
        if self.sourceEnd <= self.sourceStart:
            raise ValueError('Run source intervals must contain at least one frame.')
        return self


class SegmentRunSource(SegmentRunInterval):
    kind: Literal['source'] = Field(description='Retain these frames from the frozen working source.')


class SegmentRunGenerated(SegmentRunInterval):
    kind: Literal['generated'] = Field(description='Use the retained result from a generation step.')
    itemId: UUID = Field(description='Generation canvas node that provides the result.')
    shot: Identifier = Field(description='Identity of the inspected continuous shot used to determine guide dependencies.')
    step: Annotated[SegmentRunAnchor | SegmentRunContinuation, Field(discriminator='kind')] = Field(
        description='Independent anchor or guided continuation in this shot.')


SegmentRunEntry = Annotated[SegmentRunSource | SegmentRunGenerated, Field(discriminator='kind')]


class SegmentRunPlan(Contract):
    source: AssetRef = Field(description='Exact normalized working video whose entire frame range is delivered.')
    fps: PositiveInt = Field(description='Integer frames per second of the normalized working video.')
    frameCount: PositiveInt = Field(description='Decoded frame count of the normalized working video.')
    entries: tuple[SegmentRunEntry, ...] = Field(
        min_length=1, max_length=101, description='Delivery intervals in source playback order.')

    def by_item(self) -> dict[UUID, SegmentRunGenerated]:
        return {entry.itemId: entry for entry in self.entries if isinstance(entry, SegmentRunGenerated)}

    def execution_order(self) -> tuple[UUID, ...]:
        """Stable topological order, independent of delivery order."""
        members = self.by_item()
        visiting, completed = set(), set()
        order = []

        def visit(item_id):
            if item_id in completed:
                return
            if item_id in visiting:
                raise ValueError(f'Run guide dependencies contain a cycle at {item_id}.')
            entry = members[item_id]
            visiting.add(item_id)
            if isinstance(entry.step, SegmentRunContinuation):
                donor = members.get(entry.step.upstreamItemId)
                if donor is None or donor.shot != entry.shot:
                    raise ValueError(f'Run step {item_id} must obtain guides from a member of shot {entry.shot!r}.')
                visit(donor.itemId)
            visiting.remove(item_id)
            completed.add(item_id)
            order.append(item_id)

        for item_id in members:
            visit(item_id)
        return tuple(order)

    @model_validator(mode='after')
    def delivery(self):
        if self.source.kind != 'video':
            raise ValueError('Run source must be a video asset.')
        cursor = 0
        shot_members = defaultdict(list)
        members = set()
        for entry in self.entries:
            if entry.sourceStart != cursor:
                lo, hi = sorted((cursor, entry.sourceStart))
                issue = 'gap' if entry.sourceStart > cursor else 'overlap or ordering error'
                raise ValueError(f'Run source coverage has a {issue} at [{lo}, {hi}).')
            cursor = entry.sourceEnd
            if isinstance(entry, SegmentRunGenerated):
                if entry.itemId in members:
                    raise ValueError(f'Run generation node {entry.itemId} occurs more than once.')
                members.add(entry.itemId)
                shot_members[entry.shot].append(entry.step)

        if cursor < self.frameCount:
            raise ValueError(f'Run source coverage has a gap at [{cursor}, {self.frameCount}).')
        if cursor > self.frameCount:
            raise ValueError(f'Run source coverage exceeds the video at [{self.frameCount}, {cursor}).')
        if not members:
            raise ValueError('A segment run must contain at least one generation step.')
        for shot, steps in shot_members.items():
            if sum(isinstance(step, SegmentRunAnchor) for step in steps) != 1:
                raise ValueError(f'Run shot {shot!r} must have one anchor. Other members require continuation guides.')
        self.execution_order()
        return self
