"""Read-only node sources with stable identity; copies never borrow edit leases."""
import hashlib
import json
import threading
from collections import OrderedDict
from pathlib import Path
import tempfile

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import current_asset, visible_item_ids
from opendirector.application.subject_library import SubjectLibrary
from opendirector.domain.projects import ProjectError
from opendirector.ports.gateway import gateway


class CanvasSources:
    _CACHE_PROJECTS = 8

    def __init__(self, projects):
        self.projects = projects
        # A grid asks for one request per card; replaying the commit chain for
        # each of them turned four previews into a ten-second wait.
        self._latest: "OrderedDict[str, tuple]" = OrderedDict()
        # The catalog lock is global and polling, so waiting on it from several
        # threads at once is far slower than taking turns here.
        self._lock = threading.Lock()

    def _read(self, project_id):
        key = str(project_id)
        # Everything here takes turns: the catalog lock is global and polling,
        # so a grid of parallel requests was collapsing to a crawl.
        with self._lock:
            head = self.projects.head(project_id)
            cached = self._latest.get(key)
            if cached is not None and cached[0] == head:
                self._latest.move_to_end(key)
                return cached[1], cached[2]
            rows, read = self._build(project_id)
            self._latest[key] = (head, rows, read)
            self._latest.move_to_end(key)
            while len(self._latest) > self._CACHE_PROJECTS:
                self._latest.popitem(last=False)
            return rows, read

    def _build(self, project_id):
        snapshot = self.projects.snapshot(project_id)
        assets = {asset.id: asset for asset in snapshot.assets}
        documents = {doc.id: doc for doc in snapshot.editorDocuments}
        def resource(ref):
            asset = assets[ref.assetId]
            return dict(id=str(asset.id), assetId=str(asset.id), kind=asset.kind, title=asset.name,
                        **asset.metadata.model_dump(mode='json'), fingerprint=asset.fingerprint)
        def read(value):
            # The snapshot above already pins this read; reloading the chain per
            # media request made a grid of thumbnails wait seconds for nothing.
            stream, _ = CreationAssets(self.projects).open_media(project_id, value['assetId'], snapshot=snapshot)
            with stream:
                return stream.read()
        rows = []
        visible = visible_item_ids(snapshot)
        for item in snapshot.canvasItems:
            if item.id not in visible:
                continue
            if item.kind == 'subject':
                data = documents[item.binding.objectRef.id].data
                if not data.main:
                    continue
                content = dict(description=data.description, category=data.category, main=resource(data.main),
                    auxiliaries=[resource(ref) for ref in data.auxiliaries], voice=resource(data.voice) if data.voice else None)
            else:
                asset = current_asset(snapshot, item)
                if asset is None:
                    continue
                from opendirector.application.creation_canvas import asset_ref
                content = dict(main=resource(asset_ref(asset)))
            rows.append(self._row(str(item.id), item.title, item.kind, content))
        return rows, read

    @staticmethod
    def _resources(content):
        result = dict(main=content.get('main'))
        result.update({f'auxiliary:{i}': value for i, value in enumerate(content.get('auxiliaries', []))})
        if content.get('voice'):
            result['voice'] = content['voice']
        return result

    @staticmethod
    def _row(node_id, title, kind, content):
        identity = dict(nodeId=node_id, title=title, kind=kind, content=content)
        revision = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return dict(**identity, revision=revision)

    def list(self, project_id):
        rows, _ = self._read(project_id)
        return [dict(nodeId=row['nodeId'], title=row['title'], kind=row['kind'], revision=row['revision'],
                     main=row['content']['main'], hasVoice=bool(row['content'].get('voice')),
                     auxiliaryCount=len(row['content'].get('auxiliaries', []))) for row in rows]

    def source(self, project_id, node_id, revision):
        rows, read = self._read(project_id)
        row = next((row for row in rows if row['nodeId'] == str(node_id)), None)
        if row is None:
            raise ProjectError('来源节点内容为空或已移除。', 410)
        if row['revision'] != revision:
            raise ProjectError('来源节点已变化，请重新选择。', 409)
        return row, read

    def media(self, project_id, node_id, revision, slot):
        row, read = self.source(project_id, node_id, revision)
        value = self._resources(row['content']).get(slot)
        if not value:
            raise ProjectError('来源素材槽位不存在。', 404)
        return read(value), value

    def prepare(self, project_id, node_id, revision, slot='main', subject=True):
        row, read = self.source(project_id, node_id, revision)
        content = row['content']
        if len(content.get('auxiliaries', [])) > 3:
            raise ProjectError('主体最多包含 3 张附加图片。', 422)
        resources = self._resources(content)
        if row['kind'] != 'subject':
            resources = {slot: content['main']}
        elif slot != 'main':
            raise ProjectError('附图和声音槽位请选择单个媒体。', 422)
        media = []
        total = 0
        for destination, value in resources.items():
            payload = read(value)
            total += len(payload)
            if total > 256 * 1024 * 1024:
                raise ProjectError('来源素材总量超过限制。', 413)
            if len(payload) > 50 * 1024 * 1024:
                raise ProjectError('来源素材超过大小限制。', 413)
            with tempfile.TemporaryDirectory(prefix='opendirector-source-') as folder:
                path = Path(folder) / 'media'
                path.write_bytes(payload)
                if subject or row['kind'] == 'subject':
                    kind, metadata = SubjectLibrary.inspect(path, 'auxiliary:0' if destination == 'auxiliary' else destination)
                else:
                    kind, metadata = gateway().inspect_file(path, value.get('title') or 'source.bin', expected_kind=value['kind'])
                facts = metadata.model_dump(mode='json')
            label = value.get('title') or row['title'] or 'source'
            name = ''.join('_' if ord(char) < 32 or char in '<>:"/\\|?*' else char for char in label).strip()[:180] or 'source'
            media.append(dict(slot=destination, sourceSlot=destination if row['kind'] == 'subject' else 'main',
                sha=hashlib.sha256(payload).hexdigest(), kind=kind, metadata=facts, name=name))
        if row['kind'] == 'subject' and media[0]['kind'] == 'video' and len(media) != 1:
            raise ProjectError('视频主体不能包含附图或独立声音。', 422)
        if len({value['sha'] for value in media}) != len(media):
            raise ProjectError('主体不能包含重复素材。', 422)
        return dict(title=row['title'], kind=row['kind'], category=content.get('category', 'character'),
                    description=content.get('description', ''), media=media)
