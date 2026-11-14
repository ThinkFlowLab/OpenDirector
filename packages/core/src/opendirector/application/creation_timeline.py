"""Shared resource validation for retained timeline edits and publication."""
from opendirector.application.creation_assets import CreationAssets
from opendirector.domain.creation.assets import AssetRef
from opendirector.domain.creation.editors import TimelineData
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.media.fonts import FONT_MIMES, inspect_font, require_font_characters

from opendirector.domain.rule_facts import TIMELINE_DURATION_EPSILON, TIMELINE_FONT_TOTAL_BYTES
from opendirector.domain.timeline_errors import timeline_error_message


def timeline_source_refs(data: TimelineData) -> tuple[AssetRef, ...]:
    """Capture only used inputs, in deterministic document traversal order."""
    used_fonts = {overlay.fontId for overlay in data.overlays}
    refs = [clip.resource.asset for track in data.tracks for clip in track.clips]
    refs.extend(font.asset for font in data.fonts if font.id in used_fonts)
    refs.extend(overlay.sourceAsset for overlay in data.overlays if overlay.sourceAsset)
    unique = {}
    for ref in refs:
        unique.setdefault((ref.assetId, ref.revision, ref.fingerprint, ref.kind), ref)
    return tuple(unique.values())


def validate_timeline_resources(data: TimelineData, snapshot: ProjectSnapshot, assets: CreationAssets) -> None:
    refs = timeline_source_refs(data)
    for ref in refs:
        asset = assets._reference(snapshot, ref)
        assets.reference_available(snapshot.project.id, asset.id, snapshot=snapshot)
    for track in data.tracks:
        for clip in track.clips:
            asset = assets._reference(snapshot, clip.resource.asset)
            duration = asset.metadata.durationSeconds
            # An unknown duration cannot prove an overflow, and the aggregate
            # validation and the document boundary already read it that way.
            if asset.kind != 'image' and duration is not None and clip.outPoint > duration + TIMELINE_DURATION_EPSILON:
                raise ContractError('invalid_input', '时间线片段超出实际素材时长。', asset.id)
    text_by_font = {}
    for overlay in data.overlays:
        text_by_font.setdefault(overlay.fontId, []).append(overlay.text)
    used = {font.asset.fingerprint: assets._reference(snapshot, font.asset).metadata.size
            for font in data.fonts if font.id in text_by_font}
    if sum(used.values()) > TIMELINE_FONT_TOTAL_BYTES:
        raise ContractError('timeline_font_total_bytes', timeline_error_message('timeline_font_total_bytes', None))
    for font in data.fonts:
        asset = assets._reference(snapshot, font.asset)
        if asset.kind != 'file' or asset.metadata.mimeType not in FONT_MIMES:
            raise ContractError('timeline_font_unverified', timeline_error_message('timeline_font_unverified', None), asset.id)
        stream, _ = assets.open_media(snapshot.project.id, asset.id, snapshot=snapshot)
        with stream:
            inspection = inspect_font(stream)
            if inspection.mimeType != asset.metadata.mimeType:
                raise ContractError('timeline_font_mime', timeline_error_message('timeline_font_mime', None), asset.id)
            if font.id in text_by_font:
                require_font_characters(stream, asset.fingerprint, '\n'.join(text_by_font[font.id]))
