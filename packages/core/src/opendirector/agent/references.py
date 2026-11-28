"""Resolve chat inputs to project-owned sources before entering any runtime."""
from collections.abc import Iterable
from typing import Literal
from uuid import UUID, uuid5

from pydantic import BaseModel, Field, JsonValue, ValidationError

from opendirector.application.creation_canvas import asset_ref, current_asset
from opendirector.domain.creation.assets import AssetRef
from opendirector.domain.creation.base import CanvasItemVersion, Contract, Fingerprint
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.projects import ProjectError
from opendirector.domain.rule_facts import MAX_REFERENCES


class ChatReference(BaseModel):
    assetId: UUID
    nodeId: UUID | None = None
    sourceRole: str | None = Field(default=None, max_length=32)
    binding: Literal['asset'] | None = None
    fingerprint: Fingerprint | None = None


class TurnReference(Contract):
    id: UUID = Field(description='Stable identifier for one selected source in this chat turn.')
    name: str = Field(description='Source label captured when the request was accepted.')
    asset: AssetRef = Field(description='Exact project asset version captured at chat submission.')
    sourceVersion: CanvasItemVersion | None = Field(default=None, description='Selected canvas item and its version.')
    sourceRole: str | None = Field(default=None, description='Selected slot within the canvas item, when applicable.')

    def observation(self) -> dict[str, JsonValue]:
        value = self.model_dump(mode='json', exclude_none=True)
        pinned = {'binding': 'pinned', 'source': value['asset']}
        if self.sourceVersion is not None:
            value['sourceItemId'] = str(self.sourceVersion.id)
            pinned['sourceVersion'] = value['sourceVersion']
        if self.sourceRole:
            pinned['subjectRole'] = self.sourceRole.split(':', 1)[0]
        value['pinned'] = pinned
        return value


def resolve_turn_references(snapshot: ProjectSnapshot, turn_id: UUID,
                            content: Iterable[dict[str, JsonValue]], attachment_ids: Iterable[UUID]) -> tuple[TurnReference, ...]:
    assets = {asset.id: asset for asset in snapshot.assets}
    items = {item.id: item for item in snapshot.canvasItems}
    documents = {document.id: document for document in snapshot.editorDocuments}
    references: dict[tuple[UUID | None, UUID | str | None], TurnReference] = {}
    attached: set[UUID] = set()

    def invalid(identity: UUID | int) -> ProjectError:
        return ProjectError(f'聊天引用 {identity} 的来源或素材版本已失效，请重新选择此引用。',
                            409, code='reference_invalid')

    def resolve(part: ChatReference) -> None:
        node_id = part.nodeId if part.binding != 'asset' else None
        role = part.sourceRole if node_id is not None else None
        asset = assets.get(part.assetId)
        if asset is None or (part.fingerprint and part.fingerprint != asset.fingerprint):
            raise invalid(node_id or part.assetId)
        version = None
        name = asset.name
        if node_id is not None:
            item = items.get(node_id)
            if item is None:
                raise invalid(node_id)
            if item.kind == 'subject' and item.binding.role == 'editor':
                data = documents[item.binding.objectRef.id].data
                slots = {'main': data.main, 'voice': data.voice,
                         **{f'auxiliary:{i}': source for i, source in enumerate(data.auxiliaries)}}
                source = slots.get(role)
                matches = source is not None and source.assetId == asset.id and source.fingerprint == asset.fingerprint
            else:
                source = current_asset(snapshot, item)
                matches = role is None and source is not None and source.id == asset.id
            if not matches:
                raise invalid(node_id)
            version = CanvasItemVersion(objectType='canvas_item', id=item.id, revision=item.revision)
            name = item.title or name
        attached.add(asset.id)
        key = (node_id, role) if node_id is not None else (None, asset.id)
        if key not in references:
            references[key] = TurnReference(id=uuid5(turn_id, f'input:{len(references)}'), name=name,
                                            sourceVersion=version, sourceRole=role, asset=asset_ref(asset))

    for index, part in enumerate(content, start=1):
        if part.get('type') == 'reference':
            try:
                reference = ChatReference.model_validate(part)
            except ValidationError:
                raise invalid(index) from None
            resolve(reference)
    for asset_id in attachment_ids:
        if asset_id not in attached:
            resolve(ChatReference(assetId=asset_id))
    if len(references) > MAX_REFERENCES:
        raise ProjectError('聊天引用超过数量上限，请移除部分引用。', code='invalid_input')
    return tuple(references.values())
