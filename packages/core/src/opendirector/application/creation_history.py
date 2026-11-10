"""Scoped user history, immutable configuration versions and dependency queries."""
from copy import deepcopy
from uuid import UUID, uuid5

from pydantic import Field

from opendirector.application.creation_canvas import CreationCanvas, current_asset, resolve_reference, visible_item_ids, validate_frame_reference_limit
from opendirector.domain.creation.base import Contract, digest
from opendirector.domain.creation.project import ProjectSnapshot, asset_references
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.projects import ProjectError
from opendirector.ports.files import AssetFileDelete
from opendirector.ports.gateway import gateway

EDITABLE = {'canvasItems', 'generationSpecs', 'references', 'editorDocuments'}
ABSENT = object()
UNDOABLE = {'canvas.createGeneration', 'creation.batch', 'canvas.show', 'canvas.hide', 'canvas.move', 'canvas.update', 'canvas.configure',
    'canvas.materialize', 'canvas.applyEdit', 'timeline.publishRender', 'canvas.publishMedia', 'canvas.applyVersion', 'canvas.attachEditor', 'canvas.detachEditor', 'generationSpec.update', 'generationSpec.restore',
    'reference.add', 'reference.update', 'reference.restore', 'reference.remove', 'result.select', 'editor.save', 'generationSpec.setPrompt'}


class Preview(Contract):
    snapshot: ProjectSnapshot = Field(description='Authoritative project snapshot.')
    assetIds: tuple[UUID, ...] = Field(description='Target asset IDs.')
    clearHistory: bool = Field(description='Whether the confirmed deletion also clears dependent history.')


def fields(before, after, *, root=True):
    """Nested field paths prevent undoing one edit from clobbering another."""
    if isinstance(before, dict) and isinstance(after, dict):
        for key in before.keys() | after.keys():
            if key == 'revision' and root:
                continue
            if key not in before or key not in after:
                yield (key,), before.get(key, ABSENT), after.get(key, ABSENT)
            else:
                for path, old, new in fields(before[key], after[key], root=False):
                    yield (key, *path), old, new
    elif before != after:
        yield (), before, after


def at(value, path):
    for key in path:
        if not isinstance(value, dict):
            return ABSENT
        value = value.get(key, ABSENT)
    return value


def put(value, path, content):
    for key in path[:-1]:
        value = value.setdefault(key, {})
    if content is ABSENT:
        value.pop(path[-1], None)
    else:
        value[path[-1]] = deepcopy(content)


class CreationHistory:
    def __init__(self, projects, *, assets=None):
        from opendirector.application.creation_assets import CreationAssets
        self.projects = projects
        self.assets = assets or CreationAssets(projects)

    def states(self, project_id):
        cleared, entries = self.projects.history_index(project_id)
        return self._entry_states(cleared, entries)

    @staticmethod
    def _states(records):
        return CreationHistory._entry_states(records[0].snapshot.undoClearedThrough,
            [dict(commandId=r.command.commandId, type=r.command.type, cursor=r.event.cursor,
                  source=r.event.source, targetCommandId=getattr(r.command.payload, 'targetCommandId', None))
             for r in records if r.event is not None])

    @staticmethod
    def _entry_states(cleared, entries):
        states = {}
        future = set()
        known = set()
        for entry in reversed(entries):
            if entry['cursor'] <= cleared:
                continue
            kind = entry['type']
            if kind in UNDOABLE and entry['source'] in {'ui', 'agent'}:
                # A fresh edit starts a new branch; undone edits are no longer
                # redo candidates. Background execution facts do not clear it.
                for key in future:
                    states.pop(key, None)
                future.clear()
                states[entry['commandId']] = 'applied'
                known.add(entry['commandId'])
            elif kind in {'history.undo', 'history.redo'}:
                target = entry['targetCommandId']
                if target in known:
                    # The latest transition owns the next undo/redo position.
                    # Accepted replay events remain facts even when a new
                    # replay of that target would no longer be offered.
                    states.pop(target, None)
                    states[target] = 'undone' if kind == 'history.undo' else 'applied'
                    if kind == 'history.undo':
                        future.add(target)
                    else:
                        future.discard(target)
        return states

    def reference_catalog(self, project_id):
        snapshot = self.projects.snapshot(project_id)
        current, _, historical = self._inventory(snapshot)
        listed = {a.id for a in snapshot.assets if a.id not in historical or a.id in current}
        owners = {}
        for item in snapshot.canvasItems:
            asset = current_asset(snapshot, item)
            if asset:
                owners.setdefault(asset.id, []).append(dict(nodeId=str(item.id), nodeTitle=item.title))
            if item.kind == 'subject' and item.binding.role == 'editor':
                doc = next(doc for doc in snapshot.editorDocuments if doc.id == item.binding.objectRef.id)
                for role, ref in [('main', doc.data.main), *[(f'auxiliary:{index}', ref) for index, ref in enumerate(doc.data.auxiliaries)], ('voice', doc.data.voice)]:
                    if ref:
                        owners.setdefault(ref.assetId, []).append(dict(nodeId=str(item.id), nodeTitle=item.title, sourceRole=role))
        from opendirector.application.creation_assets import CreationAssets
        service = CreationAssets(self.projects)
        result = []
        for asset in snapshot.assets:
            file_available = True
            try:
                service.reference_available(project_id, asset.id)
            except (ContractError, ProjectError, OSError, ValueError):
                file_available = False
            available = file_available and (asset.id in listed or asset.id in owners)
            for owner in owners.get(asset.id, [{}]):
                result.append(dict(id=str(asset.id), name=asset.name, kind=asset.kind, type=asset.metadata.mimeType,
                    size=asset.metadata.size, width=asset.metadata.width, height=asset.metadata.height, durationSeconds=asset.metadata.durationSeconds, fingerprint=asset.fingerprint, available=available, fileAvailable=file_available, **owner))
        return result

    def operations(self, project_id):
        cleared, entries = self.projects.history_index(project_id)
        states = self._entry_states(cleared, entries)
        by_id = {entry['commandId']: entry for entry in entries}
        return [dict(commandId=key, type=by_id[key]['type'], state=states[key], cursor=by_id[key]['cursor'])
                for key in reversed(states)]

    def versions(self, project_id, spec_id):
        snapshot = self.projects.snapshot(project_id)
        spec = next((s for s in snapshot.generationSpecs if str(s.id) == str(spec_id)), None)
        if spec is None:
            raise ContractError('missing_object', '生成配置不存在。', UUID(str(spec_id)))
        configurations, last = [], None
        records = self.projects.history(project_id)
        accepted = {job_id: record.command.commandId for record in records for job_id in record.receipt.jobIds}
        for record in reversed(records):
            value = next((s for s in record.snapshot.generationSpecs if s.id == spec.id), None)
            if value is not None:
                refs = [r for r in record.snapshot.references if r.active and r.targetSpecId == spec.id]
                identity = dict(spec=value.model_dump(exclude={'revision', 'currentResultId'}),
                    references=[r.model_dump(exclude={'revision'}) for r in refs])
                if identity != last:
                    configurations.append(dict(commandId=record.command.commandId, spec=value,
                        references=refs))
                    last = identity
        return dict(spec=spec, configurations=list(reversed(configurations)),
            jobs=[dict(job=j, configurationCommandId=accepted.get(j.id)) for j in snapshot.jobs if j.inputSnapshot.spec.id == spec.id],
            results=[dict(result=r, job=next(j for j in snapshot.jobs if j.id == r.jobId), configurationCommandId=accepted.get(r.jobId))
                     for r in reversed(snapshot.results) if r.specId == spec.id])

    def execute(self, command, *, session=None, source='ui'):
        if command.type == 'asset.delete':
            return self._delete(command, session=session, source=source)
        def apply(before, records):
            if command.type == 'canvas.applyVersion':
                from opendirector.application.creation_node_versions import apply_node_version
                return apply_node_version(self, before, command)
            if command.type == 'generationSpec.restore':
                return self._restore(before, command)
            states = self._states(records)
            expected = 'applied' if command.type == 'history.undo' else 'undone'
            target_id = command.payload.targetCommandId
            if states.get(target_id) != expected:
                raise ContractError('revision_conflict', '该操作不能撤销或重做，请刷新历史。', target_id)
            target = next((record for record in records if record.command.commandId == target_id), None)
            previous = next((record for record in records if target and record.command.commandId == target.previousHead), None)
            prior = previous.snapshot if previous else None
            if target is None or prior is None or target.command.type not in UNDOABLE:
                raise ContractError('role_restricted', '该操作不属于可撤销编辑。', target_id)
            old, new = prior.model_dump(mode='json'), target.snapshot.model_dump(mode='json')
            data = before.model_dump(mode='json')
            undo = command.type == 'history.undo'
            for collection in EDITABLE:
                previous, following = ({o['id']: o for o in version[collection]} for version in (old, new))
                current = {o['id']: o for o in data[collection]}
                for key in previous.keys() | following.keys():
                    left, right = previous.get(key), following.get(key)
                    actual = current.get(key)
                    if left == right:
                        continue
                    if left is None and collection != 'references':
                        # Creation undo hides the display but keeps business
                        # identity, accepted jobs and generated result history.
                        if collection == 'canvasItems':
                            if actual is None or actual['visible'] != undo:
                                raise ContractError('revision_conflict', '节点显示状态已修改。', UUID(key))
                            actual['visible'] = not undo
                        continue
                    if left is None and collection == 'references':
                        if actual is None:
                            raise ContractError('missing_object', '参考历史已不存在。', UUID(key))
                        if actual['active'] != undo:
                            raise ContractError('revision_conflict', '参考关系已被后续操作修改。', UUID(key))
                        if {k: v for k, v in {**actual, 'active': True}.items() if k != 'revision'} != {k: v for k, v in right.items() if k != 'revision'}:
                            raise ContractError('revision_conflict', '参考内容已被后续编辑修改。', UUID(key))
                        actual['active'] = not undo
                        continue
                    if left is None or right is None:
                        removing = (left is None) == undo
                        expected_obj = right if left is None else left
                        if removing:
                            if actual is None or {k: v for k, v in actual.items() if k != 'revision'} != {k: v for k, v in expected_obj.items() if k != 'revision'}:
                                raise ContractError('revision_conflict', '参考关系已被后续编辑修改。', UUID(key))
                            data[collection].remove(actual)
                        else:
                            if actual is not None:
                                raise ContractError('revision_conflict', '参考关系已存在。', UUID(key))
                            data[collection].append({**expected_obj, 'revision': 1})
                        continue
                    if actual is None:
                        raise ContractError('missing_object', '历史对象已不存在。', UUID(key))
                    for path, old_value, new_value in fields(left, right):
                        if collection == 'generationSpecs' and path == ('purpose',) and undo and old_value == 'draft' and any(str(job.inputSnapshot.spec.id) == key for job in before.jobs):
                            continue  # Accepted execution is not undone with an earlier reference edit.
                        if collection == 'canvasItems' and path[0] == 'binding' and undo and left.get('binding', {}).get('role') == 'empty':
                            draft = left['binding'].get('draftSpec')
                            if draft and any(str(job.inputSnapshot.spec.id) == draft['id'] for job in before.jobs):
                                continue
                        expected_value, restore = (new_value, old_value) if undo else (old_value, new_value)
                        if at(actual, path) != expected_value:
                            raise ContractError('revision_conflict', '相关字段已被后续编辑修改，未覆盖新内容。', UUID(key))
                        put(actual, path, restore)
            self._validate_editor_locks(before, data)
            return self._revisions(before, data)
        return self.projects.commit(command, apply, session=session, source=source, with_history=True)

    @staticmethod
    def _validate_editor_locks(before, data):
        """History uses the same current owner locks as a direct editor save.

        Check only documents actually restored, so lock/unlock history and
        unrelated changes retain their existing field-scoped semantics.
        """
        previous = {str(doc.id): doc.model_dump(mode='json') for doc in before.editorDocuments}
        changed = {doc['id'] for doc in data['editorDocuments'] if previous.get(doc['id']) != doc}
        if not changed:
            return
        current = {'canvasItems': [item.model_dump(mode='json') for item in before.canvasItems]}
        for item in current['canvasItems']:
            binding = item['binding']
            owner = binding.get('objectRef') if binding['role'] == 'editor' else None
            if (owner and owner['id'] in changed) or any(editor['id'] in changed for editor in item.get('editors', [])):
                CreationCanvas._editable(current, item['id'])

    def version_counts(self, project_id):
        # Counting only reads snapshots; copying every record here made the
        # badge refresh cost ~20 s on projects with hundreds of commits.
        records = self.projects.records(project_id)
        snapshot = records[0].snapshot
        families = {i.id: set() for i in snapshot.canvasItems if i.kind in {'text', 'image', 'video', 'audio'}}
        owners = {}
        for record in records:
            for item in record.snapshot.canvasItems:
                if item.id not in families:
                    continue
                asset = current_asset(record.snapshot, item)
                if asset:
                    families[item.id].add(asset.id)
                binding = item.binding
                spec = binding.objectRef if binding.role == 'generation' else binding.draftSpec if binding.role == 'empty' else None
                if spec:
                    owners.setdefault(spec.id, set()).add(item.id)
        jobs = {j.id: j for j in snapshot.jobs}
        for result in snapshot.results:
            for item_id in owners.get(result.specId, set()) | {jobs[result.jobId].originItemId}:
                if item_id in families:
                    families[item_id].add(result.asset.assetId)
        assets = {a.id for a in snapshot.assets}
        return dict(eventCursor=snapshot.eventCursor, counts={str(key): len(value & assets) for key, value in families.items()})

    def node_versions(self, project_id, item_id):
        from opendirector.application.creation_node_versions import node_versions
        return node_versions(self.projects, project_id, item_id, assets=self.assets)

    @staticmethod
    def _revisions(before, data):
        for collection in EDITABLE:
            old = {str(o.id): o.model_dump(mode='json') for o in getattr(before, collection)}
            for obj in data[collection]:
                previous = old.get(obj['id'])
                if previous:
                    obj['revision'] = previous['revision']
                    if obj != previous:
                        obj['revision'] += 1
        result = ProjectSnapshot.model_validate(data)
        validate_frame_reference_limit(result)
        return result

    def _restore(self, before, command):
        record = next((r for r in self.projects.history(command.projectId) if r.command.commandId == command.payload.commandId), None)
        current = next((s for s in before.generationSpecs if s.id == command.payload.specId), None)
        historic = next((s for s in record.snapshot.generationSpecs if s.id == command.payload.specId), None) if record else None
        if current is None or historic is None:
            raise ContractError('missing_object', '该配置历史不存在。', command.payload.specId)
        data = before.model_dump(mode='json')
        for item in before.canvasItems:
            owner = item.binding.objectRef if item.binding.role == 'generation' else item.binding.draftSpec if item.binding.role == 'empty' else None
            if owner and owner.id == current.id:
                CreationCanvas._editable(data, item.id)
        spec = next(s for s in data['generationSpecs'] if s['id'] == str(current.id))
        spec.update(historic.model_dump(mode='json', exclude={'revision', 'purpose', 'currentResultId'}))
        old_refs = {r.id: r for r in before.references if r.targetSpecId == current.id}
        refs = []
        for ref in record.snapshot.references:
            if not ref.active or ref.targetSpecId != current.id:
                continue
            values = [ref.model_dump(mode='json')]
            if command.payload.referencePolicy == 'pinned':
                values = [{**ref.model_dump(mode='json'), 'id': str(ref.id if index == 0 else uuid5(command.commandId, f'{ref.id}:{index}')),
                    'binding': 'pinned', 'source': value.asset.model_dump(mode='json'),
                    'sourceVersion': value.sourceVersion.model_dump(mode='json') if value.sourceVersion else None}
                    for index, value in enumerate(resolve_reference(record.snapshot, ref))]
            for value in values:
                previous = old_refs.get(UUID(value['id']))
                value.update(revision=previous.revision if previous else 1, order=len(refs))
                refs.append(value)
        restored_ids = {ref['id'] for ref in refs}
        retained = [{**ref, 'active': False} if ref['targetSpecId'] == str(current.id) and ref['id'] not in restored_ids else ref
                    for ref in data['references'] if ref['id'] not in restored_ids]
        data['references'] = retained + refs
        return self._revisions(before, data)

    def usage(self, snapshot, asset_id, *, include_history=True):
        asset_id = UUID(str(asset_id))
        return self._usage_many(snapshot, [asset_id], include_history=include_history)[asset_id]

    def _usage_many(self, snapshot, asset_ids, *, include_history=True, records=None):
        """Build dependencies once per query; never cache mutable usage across requests."""
        statuses = {key: dict(assetId=str(key), used=False, reasons=[], hiddenItemIds=[]) for key in asset_ids}
        if not statuses:
            return statuses
        visible = visible_item_ids(snapshot)
        def used(kind, obj, ids=None, *, exclude_self=False):
            keys = set(ids if ids is not None else (ref.assetId for ref in asset_references(obj)))
            for key in keys & statuses.keys():
                if not exclude_self or key != obj.id:
                    statuses[key]['reasons'].append(dict(type=kind, id=str(obj.id)))
        for item in snapshot.canvasItems:
            if item.binding.role == 'generation' and item.binding.materialOverride:
                key = item.binding.materialOverride.assetId
                if key in statuses:
                    statuses[key]['reasons'].append(dict(type='visible_canvas_item' if item.id in visible else 'hidden_canvas_item', id=str(item.id)))
            if item.binding.role == 'material':
                key = item.binding.objectRef.assetId
                if key in statuses:
                    if item.id in visible:
                        statuses[key]['reasons'].append(dict(type='visible_canvas_item', id=str(item.id)))
                    else:
                        statuses[key]['hiddenItemIds'].append(str(item.id))
        for ref in snapshot.references:
            if not ref.active:
                continue
            try:
                used('reference', ref, (value.asset.assetId for value in resolve_reference(snapshot, ref)))
            except ContractError:
                # An unresolved relation is never evidence of unused media.
                for status in statuses.values():
                    status['reasons'].append(dict(type='unresolved_reference', id=str(ref.id)))
        for kind, objects in [('editor_document', snapshot.editorDocuments), ('job', snapshot.jobs),
                               ('result', snapshot.results), ('asset_provenance', snapshot.assets)]:
            for obj in objects:
                used(kind, obj, exclude_self=True)
        for document in snapshot.editorDocuments:
            if document.kind == 'stack':
                used('editor_document', document, (asset.id for item in snapshot.canvasItems
                    if item.id in document.data.nodeIds and (asset := current_asset(snapshot, item)) is not None))
        # Read independent tool ledgers once, retaining their deletion protection.
        asset_keys = {str(key): key for key in statuses}
        with self.projects.local.transaction() as db:
            path, _, _ = self.projects._load(db, snapshot.project.id)
            folder = gateway().child(path, 'tool-tasks')
            if folder.exists():
                for entry in folder.glob('*.json'):
                    task = gateway().read_json(gateway().child(folder, entry.name))
                    ids = {*task.get('sourceAssetIds', []), task.get('maskAssetId'), task.get('annotationAssetId'),
                           *(output['id'] for output in task.get('outputs', []))}
                    for key in ids & asset_keys.keys():
                        statuses[asset_keys[key]]['reasons'].append(dict(type='tool_task', id=task['id']))
        records = self.projects.history(snapshot.project.id) if records is None else records
        historical_pins = {}
        for record in records:
            for ref in record.snapshot.references:
                if ref.binding == 'pinned' and ref.source.assetId in statuses:
                    historical_pins.setdefault(ref.source.assetId, set()).add(ref.id)
        current_pins = {(ref.id, ref.source.assetId) for ref in snapshot.references if ref.binding == 'pinned'}
        for key, ref_ids in historical_pins.items():
            for ref_id in ref_ids:
                if (ref_id, key) not in current_pins:
                    statuses[key]['reasons'].append(dict(type='configuration_history', id=str(ref_id)))
        if include_history:
            states = self._states(records)
            by_id = {record.command.commandId: record for record in records}
            for record in records:
                if record.command.commandId in states and record.command.type in UNDOABLE:
                    references = list(asset_references(record.command.payload))
                    prior = by_id.get(record.previousHead)
                    for collection in EDITABLE:
                        previous = {o.id: o for o in getattr(prior.snapshot, collection)} if prior else {}
                        for obj in getattr(record.snapshot, collection):
                            if previous.get(obj.id) != obj:
                                references.extend(asset_references(obj))
                                if obj.id in previous:
                                    references.extend(asset_references(previous[obj.id]))
                    for key in {ref.assetId for ref in references} & statuses.keys():
                        statuses[key]['reasons'].append(dict(type='undo_history', id=str(record.command.commandId)))
        for status in statuses.values():
            status['used'] = bool(status['reasons'])
        return statuses

    def delete_preview(self, project_id, asset_ids, clear_history=False):
        snapshot = self.projects.snapshot(project_id)
        ids = tuple(UUID(str(value)) for value in asset_ids)
        if not ids or len(ids) > 100 or len(set(ids)) != len(ids):
            raise ContractError('invalid_input', '删除选择必须为 1 至 100 个不同资产。')
        for asset_id in ids:
            if not any(a.id == asset_id for a in snapshot.assets):
                raise ContractError('missing_object', '素材已不存在。', asset_id)
        statuses = self._usage_many(snapshot, ids, include_history=not clear_history)
        usage = [statuses[key] for key in ids]
        fingerprint = digest(Preview(snapshot=snapshot, assetIds=ids, clearHistory=clear_history))
        return dict(fingerprint=fingerprint, usage=usage, canDelete=not any(item['used'] for item in usage),
                    clearsAllUndoRedo=clear_history, hiddenItemIds=[key for item in usage for key in item['hiddenItemIds']])

    def _delete(self, command, *, session=None, source='ui'):
        replay = self.projects.replay(command)
        if replay:
            return replay
        snapshot = self.projects.snapshot(command.projectId)
        deleting = set(command.payload.assetIds)
        files = tuple(AssetFileDelete(assetId=a.id, fingerprint=a.fingerprint, size=a.metadata.size) for a in snapshot.assets if a.id in deleting)
        def apply(before):
            preview = self.delete_preview(command.projectId, command.payload.assetIds, command.payload.clearHistory)
            if preview['fingerprint'] != command.expectedPreview:
                raise ContractError('preview_expired', '素材使用情况已变化，请重新检查删除影响。')
            if not preview['canDelete']:
                raise ContractError('role_restricted', '素材仍被参考、任务、历史或编辑文档使用。')
            with self.projects.local.transaction() as db:
                path = self.projects._find(db, command.projectId)[0]
            for deletion in files:
                file = gateway().child(gateway().child(path, 'assets'), str(deletion.assetId))
                if (file.exists() or file.is_symlink()) and gateway().file_identity(file) != (deletion.fingerprint, deletion.size):
                    raise ContractError('preview_expired', '本地素材文件已变化，请核对原文件后重新检查删除影响。', deletion.assetId)
            data = before.model_dump(mode='json')
            visible = visible_item_ids(before)
            data['assets'] = [a for a in data['assets'] if UUID(a['id']) not in deleting]
            for item in data['canvasItems']:
                binding = item['binding']
                if UUID(item['id']) not in visible and binding['role'] == 'material' and UUID(binding['objectRef']['assetId']) in deleting:
                    item['binding'] = dict(role='empty', draftSpec=None, manualText=None)
            if command.payload.clearHistory:
                data['undoClearedThrough'] = before.eventCursor
            return self._revisions(before, data)
        return self.projects.commit(command, apply, session=session, source=source, deletes=files)

    def _inventory(self, snapshot, *, records=None):
        current = {asset.id for item in snapshot.canvasItems if (asset := current_asset(snapshot, item)) is not None}
        current_results = {result.asset.assetId: spec.id for spec in snapshot.generationSpecs for result in snapshot.results if spec.currentResultId == result.id}
        current.update(current_results)
        historical = {r.asset.assetId for r in snapshot.results}
        historical.update(source.assetId for asset in snapshot.assets for source in asset.provenance.sources)
        # Every adopted manual/uploaded sibling is a version, including a newer
        # sibling after applying an older version. Hidden current owners stay live.
        for record in self.projects.history(snapshot.project.id) if records is None else records:
            historical.update(asset.id for item in record.snapshot.canvasItems if (asset := current_asset(record.snapshot, item)) is not None)
            for doc in record.snapshot.editorDocuments:
                if doc.kind == 'subject':
                    historical.update(ref.assetId for ref in asset_references(doc))
        for doc in snapshot.editorDocuments:
            if doc.kind == 'subject':
                current.update(ref.assetId for ref in asset_references(doc))
        # A live pinned reference keeps its fixed media reusable even without a canvas
        # node, after the media has also become a generated result's source.
        current.update(ref.source.assetId for ref in snapshot.references if ref.active and ref.binding == 'pinned')
        return current, current_results, historical

    def asset_list(self, project_id, *, text='', usage='all', visibility='all', category='all', offset=0, limit=100):
        records = self.projects.history(project_id)
        snapshot = records[0].snapshot
        current, current_results, historical = self._inventory(snapshot, records=records)
        visible = visible_item_ids(snapshot)
        owners = {}
        for item in snapshot.canvasItems:
            asset = current_asset(snapshot, item)
            if asset:
                owners.setdefault(asset.id, []).append(dict(itemId=item.id, title=item.title, visible=item.id in visible))
        query = text.casefold()
        candidates = [(order, asset) for order, asset in enumerate(snapshot.assets)
                      if (asset.id not in historical or asset.id in current)
                      and (visibility == 'all' or any(owner['visible'] for owner in owners.get(asset.id, [])) == (visibility == 'visible'))
                      and (query in asset.name.casefold() or any(query in owner['title'].casefold() for owner in owners.get(asset.id, [])))]
        statuses = self._usage_many(snapshot, [asset.id for _, asset in candidates], records=records)
        listed = []
        for order, asset in candidates:
            status = statuses[asset.id]
            if usage != 'all' and status['used'] != (usage == 'used'):
                continue
            listed.append(dict(asset=asset, usage=status, owners=owners.get(asset.id, []),
                               specId=current_results.get(asset.id), createdOrder=order,
                               categories=[asset.kind]))
        listed.sort(key=lambda row: (-row['createdOrder'], row['asset'].name.casefold()))
        documents = {document.id: document for document in snapshot.editorDocuments}
        assets = {asset.id: asset for asset in snapshot.assets}
        node_rows = []
        for index, item in enumerate(snapshot.canvasItems):
            if item.kind not in {'subject', 'timeline'} or item.binding.role != 'editor':
                continue
            displayed = item.id in visible
            if visibility != 'all' and displayed != (visibility == 'visible'):
                continue
            if query not in item.title.casefold():
                continue
            document = documents[item.binding.objectRef.id]
            preview = document.data.main if item.kind == 'subject' else next(
                (clip.resource.asset for track in document.data.tracks if track.kind == 'visual' for clip in track.clips), None)
            node_rows.append(dict(itemId=item.id, title=item.title, kind=item.kind, visible=displayed,
                asset=assets.get(preview.assetId) if preview else None,
                previewLabel='主体' if item.kind == 'subject' else '时间线首个画面',
                createdOrder=len(snapshot.assets) + index))
        kinds = ('image', 'video', 'audio', 'text', 'subject', 'timeline')
        counts = dict(all=len(listed) + len(node_rows), **{kind:
            sum(kind in row['categories'] for row in listed) + sum(row['kind'] == kind for row in node_rows) for kind in kinds})
        entries = [('asset', row) for row in listed if category == 'all' or category in row['categories']]
        entries.extend(('node', row) for row in node_rows if category == 'all' or row['kind'] == category)
        entries.sort(key=lambda entry: -entry[1]['createdOrder'])
        page = entries[offset:offset+limit]
        return dict(items=[row for kind, row in page if kind == 'asset'],
            nodes=[row for kind, row in page if kind == 'node'], total=len(entries),
            eventCursor=snapshot.eventCursor, counts=counts)
