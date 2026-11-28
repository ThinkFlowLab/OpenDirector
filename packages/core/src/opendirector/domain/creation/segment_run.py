"""Typed input and deterministic ordering for a full-source video run."""

from collections import defaultdict
from typing import Annotated, Literal, TYPE_CHECKING
from uuid import UUID

from pydantic import Field, JsonValue, model_validator

from .assets import AssetRef
from .base import Contract, Identifier, PositiveInt
from .generation import FollowingReference, PinnedReference

if TYPE_CHECKING:
    from .canvas import GroupCanvasItem
    from .project import ProjectSnapshot


SourceFrame = Annotated[int, Field(strict=True, ge=0)]
GuideFrame = Annotated[int, Field(strict=True, ge=0, le=359)]


class SegmentRunAnchor(Contract):
    kind: Literal['anchor'] = Field(description='One independent generation anchor in the declared source shot.')


class SegmentRunContinuation(Contract):
    kind: Literal['continuation'] = Field(description='Generation requires the selected upstream result as a guide.')
    upstreamItemId: UUID = Field(description='Generation node providing the raw guide frames.')
    sourceFrames: tuple[GuideFrame, ...] = Field(
        min_length=1, max_length=2,
        description='Raw upstream frame indices for output frame 0, or frames 0 and 21 in order.')

    @model_validator(mode='after')
    def distinct_frames(self):
        if len(set(self.sourceFrames)) != len(self.sourceFrames):
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
    replacementPromptInputs: dict[str, JsonValue] | None = Field(
        default=None, exclude_if=lambda value: value is None,
        description='Structured character-replacement prompt inputs rendered and checked by the server.')
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
        members = {}
        for entry in self.entries:
            if entry.sourceStart != cursor:
                lo, hi = sorted((cursor, entry.sourceStart))
                issue = 'gap' if entry.sourceStart > cursor else 'overlap or ordering error'
                raise ValueError(f'Run source coverage has a {issue} at [{lo}, {hi}).')
            cursor = entry.sourceEnd
            if isinstance(entry, SegmentRunGenerated):
                previous = members.setdefault(entry.itemId, entry)
                if previous is entry:
                    shot_members[entry.shot].append(entry.step)
                elif (previous.shot, previous.step, previous.replacementPromptInputs) != (
                        entry.shot, entry.step, entry.replacementPromptInputs):
                    raise ValueError(f'Run generation node {entry.itemId} must reuse the same shot, step and prompt inputs.')

        if cursor < self.frameCount:
            raise ValueError(f'Run source coverage has a gap at [{cursor}, {self.frameCount}).')
        if cursor > self.frameCount:
            raise ValueError(f'Run source coverage exceeds the video at [{self.frameCount}, {cursor}).')
        if not members:
            raise ValueError('A segment run must contain at least one generation step.')
        missing = [entry.itemId for entry in members.values() if entry.replacementPromptInputs is None]
        if missing and len(missing) != len(members):
            raise ValueError(f'All generated Run entries need replacement prompt inputs: {missing}.')
        for shot, steps in shot_members.items():
            if sum(isinstance(step, SegmentRunAnchor) for step in steps) != 1:
                raise ValueError(f'Run shot {shot!r} must have one anchor. Other members require continuation guides.')
        self.execution_order()
        return self

    def validate_for(self, snapshot: 'ProjectSnapshot', group: 'GroupCanvasItem') -> None:
        """Compare the typed plan to the saved business objects before publication."""
        asset = next((asset for asset in snapshot.assets if asset.id == self.source.assetId), None)
        if asset is None or (asset.revision, asset.fingerprint, asset.kind) != (
                self.source.revision, self.source.fingerprint, self.source.kind):
            raise ValueError('Run source asset is missing or has a different version.')
        if asset.metadata.frameRate is not None and asset.metadata.frameRate != self.fps:
            raise ValueError('Run source frame rate differs from the normalized video.')

        recipe = group.assembly
        generated_entries = tuple(entry for entry in self.entries if isinstance(entry, SegmentRunGenerated))
        if recipe is None or tuple(clip.itemId for clip in recipe.clips) != tuple(entry.itemId for entry in generated_entries):
            raise ValueError('Run assembly must contain exactly its generation nodes in source order.')

        items = {item.id: item for item in snapshot.canvasItems}
        specs = {spec.id: spec for spec in snapshot.generationSpecs}
        refs = {ref.id: ref for ref in snapshot.references}
        bound_specs = set()
        validated = set()
        for clip, entry in zip(recipe.clips, generated_entries):
            item_id = clip.itemId
            if clip.outFrame - clip.inFrame != entry.sourceEnd - entry.sourceStart:
                raise ValueError(f'Run step {item_id} keep length does not match its source interval.')
            if item_id in validated:
                continue
            validated.add(item_id)
            item = items.get(item_id)
            if item is None or item.kind != 'video' or item.binding.role != 'generation':
                raise ValueError(f'Run step {item_id} requires a video generation node.')
            spec = specs.get(item.binding.objectRef.id)
            if spec is None or spec.kind != 'video' or spec.id in bound_specs:
                raise ValueError(f'Run step {item_id} requires a distinct video generation configuration.')
            bound_specs.add(spec.id)
            if spec.modelConfigId is None or spec.parameters.videoMode != 'reference':
                raise ValueError(f'Run step {item_id} requires a model configured in reference mode.')

            segment = spec.parameters.h3Segment
            if isinstance(entry.step, SegmentRunAnchor):
                if segment is not None and segment.guideReferenceId is not None:
                    guide = refs.get(segment.guideReferenceId)
                    if (segment.outputFrame is None or not isinstance(guide, PinnedReference)
                            or not guide.active or guide.targetSpecId != spec.id or guide.role != 'reference'
                            or guide.source.kind != 'image'):
                        raise ValueError(f'Run anchor {item_id} requires a pinned image for its static guide.')
                continue
            guide = refs.get(segment.guideReferenceId) if segment is not None else None
            if (not isinstance(guide, FollowingReference) or not guide.active or guide.role != 'reference'
                    or guide.targetSpecId != spec.id or guide.source.id != entry.step.upstreamItemId
                    or segment.sourceFrames != entry.step.sourceFrames):
                raise ValueError(f'Run step {item_id} requires live guides from {entry.step.upstreamItemId} '
                                 f'with raw frames {entry.step.sourceFrames}.')
