"""Application service for the global cross-canvas library.

Invariants (docs/ASSET-LIBRARY-DESIGN.md §5):
  L1  canvas -> library is a backup; deleting canvas data never touches the library
  L2  subjects enter only as subjects; plain media enters only as assets
  L4  trash operations never write inside any project directory
  L5  a blob is only removed once no item (active or trashed) references it
  L6  identical content is stored once
"""
from typing import List
from uuid import UUID

from opendirector.application.creation_assets import CreationAssets
from opendirector.domain.creation.base import Fingerprint
from opendirector.domain.creation.library import (
    LibraryIndex, LibraryItem, LibraryMediaMetadata, LibraryOrigin,
    LibrarySubjectSnapshot,
)
from opendirector.domain.projects import ProjectError, identifier
from opendirector.ports.gateway import gateway

ALLOWED_ASSET_KINDS = {'image', 'video', 'audio', 'file'}
MAX_LIBRARY_BYTES = 500 * 1024 * 1024


def library_name(value: str) -> str:
    text = (value or '').strip()
    if not text:
        raise ProjectError('素材名称不能为空。', 422)
    return text[:255]


class Library:
    def __init__(self, projects):
        self.projects = projects
        self.store = gateway().library(projects.state_dir)

    # -- reads -------------------------------------------------------------

    def list(self, *, kind=None, state='active', query='', media_kind_value=None) -> List[LibraryItem]:
        index = self.store.read()
        needle = (query or '').strip().lower()
        rows = [
            item for item in index.items.values()
            if item.state == state
            and (kind is None or item.kind == kind)
            and (media_kind_value is None or item.mediaKind == media_kind_value)
            and (not needle or needle in item.name.lower())
        ]
        rows.sort(key=lambda item: (item.trashedAt or item.createdAt), reverse=True)
        return rows

    def get(self, item_id) -> LibraryItem:
        key = UUID(str(item_id))
        index = self.store.read()
        item = index.items.get(key)
        if item is None:
            raise ProjectError('库中找不到该素材。', 404)
        return item

    def content(self, item_id) -> tuple[bytes, LibraryItem]:
        item = self.get(item_id)
        if item.kind == 'subject' or item.blob is None:
            raise ProjectError('主体条目没有可直接下载的素材。', 404)
        return self.store.read_blob(item.blob), item

    # -- writes ------------------------------------------------------------

    def upload(self, data: bytes, name: str, mime: str, *, origin: LibraryOrigin | None = None) -> LibraryItem:
        label = library_name(name)
        if not data:
            raise ProjectError('不能上传空文件。', 422)
        if len(data) > MAX_LIBRARY_BYTES:
            raise ProjectError('素材超过 500 MiB 上限。', 413)
        with self.store.transaction() as tx:
            if len(tx.index.items) >= 100000:
                raise ProjectError('库条目已达上限。', 409)
            blob = self.store.put_blob(data)
            item = self.store.new_asset(
                blob, label, mime or 'application/octet-stream',
                origin or LibraryOrigin(type='upload'),
                LibraryMediaMetadata(mimeType=mime or 'application/octet-stream', size=len(data)),
            )
            tx.index = self._with_item(tx.index, item)
        return item

    def add_from_canvas(self, project_id, asset_id, name=None) -> LibraryItem:
        """Copy canvas bytes into the library (L1: a backup, never a reference).

        Reads through CreationAssets so new-format (`opendirector-project`)
        canvases resolve exactly the way the canvas UI resolves them.
        """
        project = identifier(str(project_id))
        asset = identifier(str(asset_id))
        try:
            stream, facts = CreationAssets(self.projects).open_media(project, asset)
            with stream:
                data = stream.read()
        except ProjectError:
            raise ProjectError('画布素材不存在，无法加入资产。', 404) from None
        if not data:
            raise ProjectError('画布素材内容为空，无法加入资产。', 422)
        payload = bytes(data)
        if getattr(facts, 'kind', None) == 'subject':
            raise ProjectError('主体素材请通过「主体」入口加入。', 422)
        mime = getattr(getattr(facts, 'metadata', None), 'mimeType', None) or 'application/octet-stream'
        fallback = getattr(facts, 'name', '') or ''
        resolved = gateway().media_kind(mime, name or fallback)
        if resolved not in ALLOWED_ASSET_KINDS:
            raise ProjectError('只能将图片、视频、音频、文档加入资产。', 422)
        label = library_name(name or fallback or '素材')
        with self.store.transaction() as tx:
            blob = self.store.put_blob(payload)
            item = self.store.new_asset(
                blob, label, mime,
                LibraryOrigin(type='canvas', projectId=UUID(project), assetId=UUID(asset)),
                LibraryMediaMetadata(mimeType=mime, size=len(payload)),
            )
            tx.index = self._with_item(tx.index, item)
        return item

    def add_subject(self, project_id, node_id, name, subject: LibrarySubjectSnapshot,
                    preview: str | None = None) -> LibraryItem:
        label = library_name(name)
        with self.store.transaction() as tx:
            for sha in (subject.main, *subject.auxiliaries, subject.voice, preview):
                if sha and not self.store.has_blob(sha):
                    raise ProjectError('主体素材副本缺失，请重新加入。', 409)
            item = self.store.new_subject(
                label, subject,
                LibraryOrigin(type='canvas', projectId=UUID(str(project_id)),
                              nodeId=UUID(str(node_id))),
                preview=preview,
            )
            tx.index = self._with_item(tx.index, item)
        return item

    def rename(self, item_id, name: str) -> LibraryItem:
        key = UUID(str(item_id))
        label = library_name(name)
        with self.store.transaction() as tx:
            item = tx.index.items.get(key)
            if item is None:
                raise ProjectError('库中找不到该素材。', 404)
            updated = item.model_copy(update={'name': label, 'revision': item.revision + 1})
            tx.index = self._with_item(tx.index, updated)
        return updated

    def trash(self, item_ids) -> List[LibraryItem]:
        keys = [UUID(str(value)) for value in item_ids]
        stamp = gateway().library_now()
        with self.store.transaction() as tx:
            missing = [str(key) for key in keys if key not in tx.index.items]
            if missing:
                raise ProjectError('部分素材不存在，未执行删除。', 404)
            updated = []
            for key in keys:
                item = tx.index.items[key]
                if item.state == 'active':
                    item = item.model_copy(
                        update={'state': 'trashed', 'trashedAt': stamp,
                                'revision': item.revision + 1})
                    tx.index = self._with_item(tx.index, item)
                updated.append(item)
        return updated

    def restore(self, item_ids) -> List[LibraryItem]:
        keys = [UUID(str(value)) for value in item_ids]
        with self.store.transaction() as tx:
            missing = [str(key) for key in keys if key not in tx.index.items]
            if missing:
                raise ProjectError('部分素材不存在，未执行还原。', 404)
            updated = []
            for key in keys:
                item = tx.index.items[key]
                if item.state == 'trashed':
                    item = item.model_copy(
                        update={'state': 'active', 'trashedAt': None,
                                'revision': item.revision + 1})
                    tx.index = self._with_item(tx.index, item)
                updated.append(item)
        return updated

    def purge(self, item_ids=None) -> dict:
        """Permanently drop trashed items, then collect unreferenced blobs (L5)."""
        keys = None if item_ids is None else [UUID(str(value)) for value in item_ids]
        with self.store.transaction() as tx:
            targets = [
                key for key, item in tx.index.items.items()
                if item.state == 'trashed' and (keys is None or key in keys)
            ]
            if keys is not None:
                active = [str(key) for key in keys
                          if key in tx.index.items and tx.index.items[key].state != 'trashed']
                if active:
                    raise ProjectError('只能清空回收站中的素材。', 422)
                missing = [str(key) for key in keys if key not in tx.index.items]
                if missing:
                    raise ProjectError('部分素材不存在。', 404)
            remaining = {key: value for key, value in tx.index.items.items()
                         if key not in set(targets)}
            tx.index = tx.index.model_copy(update={'items': remaining})
            tx.commit_partial()
            removed = self.store.collect(tx.index)
        return {'purged': [str(key) for key in targets], 'blobsRemoved': removed}

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _with_item(index: LibraryIndex, item: LibraryItem) -> LibraryIndex:
        items = dict(index.items)
        items[item.id] = item
        return index.model_copy(update={'items': items, 'revision': index.revision + 1})