"""Resolve assistant Markdown links to stable canvas item identities.

An assistant reply may link to canvas content with a relative destination such
as ``[Finished video](output.mp4)``. The file name is matched against project
assets and their recorded provenance, then mapped to the canvas items that
display the asset. The result stores only stable object identities and typed
status codes; current geometry is deliberately not stored, so moving, renaming
or regrouping an item never invalidates a saved link.

Only inline Markdown links are considered. Fenced code blocks, inline code
spans, images and ordinary external URLs are left untouched.
"""
from __future__ import annotations

import re
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit
from uuid import UUID

LINK_STATUSES = ('focused', 'hidden', 'materialize', 'ambiguous', 'missing',
                 'cross-project', 'external')

_INLINE_CODE = re.compile(r'(`+)(?:(?!\1).)*?\1', re.DOTALL)
_FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')


def _ignored_ranges(text: str) -> list[tuple[int, int]]:
    """Fenced blocks and code spans are examples, never navigable links."""
    ranges: list[tuple[int, int]] = []
    fence = None
    fence_start = 0
    offset = 0
    for line in text.splitlines(keepends=True):
        match = _FENCE.match(line)
        if fence is None:
            if match is not None:
                fence = match.group(1)[0]
                fence_start = offset
        elif match is not None and match.group(1)[0] == fence:
            ranges.append((fence_start, offset + len(line)))
            fence = None
        offset += len(line)
    if fence is not None:
        ranges.append((fence_start, len(text)))
    for match in _INLINE_CODE.finditer(text):
        if not any(start <= match.start() < end for start, end in ranges):
            ranges.append((match.start(), match.end()))
    return sorted(ranges)


def _inside(position: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in ranges)


def _matching_bracket(text: str, start: int) -> int | None:
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == '\\':
            index += 2
            continue
        if char == '[':
            depth += 1
        elif char == ']':
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _destination(text: str, start: int) -> tuple[str | None, int]:
    """Return the link destination and the offset just after the closing paren."""
    length = len(text)
    index = start
    while index < length and text[index] in ' \t\r\n':
        index += 1
    if index < length and text[index] == '<':
        end = text.find('>', index + 1)
        if end == -1:
            return None, length
        close = text.find(')', end + 1)
        return text[index + 1:end], (close + 1 if close != -1 else length)
    depth = 0
    cursor = index
    while cursor < length:
        char = text[cursor]
        if char == '\\':
            cursor += 2
            continue
        if char == '(':
            depth += 1
        elif char == ')':
            if depth == 0:
                return text[index:cursor], cursor + 1
            depth -= 1
        elif char in ' \t\r\n' and depth == 0:
            close = text.find(')', cursor)
            return text[index:cursor], (close + 1 if close != -1 else length)
        cursor += 1
    return None, length


def link_targets(text: str) -> list[str]:
    """Extract inline Markdown link destinations outside code and images."""
    ignored = _ignored_ranges(text)
    targets: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        if _inside(index, ignored):
            index = next((end for start, end in ignored if start <= index < end), length)
            continue
        if text[index] == '\\':
            index += 2
            continue
        if text[index] == '!' and index + 1 < length and text[index + 1] == '[':
            index += 2
            continue
        if text[index] == '[':
            close = _matching_bracket(text, index)
            if close is not None and close + 1 < length and text[close + 1] == '(':
                destination, end = _destination(text, close + 2)
                if destination is not None:
                    targets.append(destination)
                index = max(end, close + 2)
                continue
        index += 1
    return targets


def _uuid(value: str) -> str | None:
    try:
        return str(UUID(str(value).strip()))
    except (ValueError, TypeError, AttributeError):
        return None


def _identity(target: str) -> tuple[str, Any]:
    """Classify a destination without touching project state or raising."""
    raw = target.strip()
    if raw.startswith('<') and raw.endswith('>'):
        raw = raw[1:-1].strip()
    if raw.startswith(('#', '?')):
        # In-page anchors and query-only destinations are not project objects.
        return 'external', raw
    if raw.startswith('project:'):
        project, separator, remainder = raw[len('project:'):].partition('/')
        if not separator:
            return 'missing', raw
        for prefix in ('canvas:', 'node:'):
            if remainder.startswith(prefix):
                project_id = _uuid(project)
                node_id = _uuid(remainder[len(prefix):])
                if project_id is None or node_id is None:
                    return 'missing', raw
                return 'project', (project_id, node_id)
        return 'missing', raw
    for prefix in ('canvas:', 'node:'):
        if raw.startswith(prefix):
            node_id = _uuid(raw[len(prefix):])
            return ('node', node_id) if node_id is not None else ('missing', raw)
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return 'missing', raw
    if parsed.scheme or parsed.netloc:
        # http(s) links keep the existing external-link policy; unsafe schemes
        # (javascript:, data:, file:) are never treated as project links.
        return 'external', raw
    path = unquote(parsed.path).replace('\\', '/')
    while path.startswith('./'):
        path = path[2:]
    path = path.lstrip('/')
    if not path or path in {'.', '..'} or path.endswith('/'):
        return 'missing', raw
    name = path.rsplit('/', 1)[-1]
    if not name or name in {'.', '..'}:
        return 'missing', raw
    return 'name', name


def format_canvas_link(node_id: str, project_id: str | None = None) -> str:
    """Canonical forms consumed by the resolver and future tool guidance."""
    node = _uuid(node_id)
    if node is None:
        raise ValueError('Canvas item id must be a UUID')
    if project_id is None:
        return f'canvas:{node}'
    project = _uuid(project_id)
    if project is None:
        raise ValueError('Project id must be a UUID')
    return f'project:{project}/canvas:{node}'


def _items(snapshot: Any) -> tuple[Any, ...]:
    return tuple(getattr(snapshot, 'canvasItems', ()) or ())


def _assets(snapshot: Any) -> tuple[Any, ...]:
    return tuple(getattr(snapshot, 'assets', ()) or ())


def _project_id(snapshot: Any) -> str:
    project = getattr(snapshot, 'project', None)
    return str(getattr(project, 'id', ''))


def _base_name(value: str) -> str:
    return str(value or '').replace('\\', '/').rsplit('/', 1)[-1]


def _asset_matches(name: str, asset: Any) -> bool:
    return name in {_base_name(getattr(asset, 'name', '')),
                    _base_name(getattr(asset, 'path', ''))}


def _binding_asset_ids(item: Any) -> list[str]:
    binding = getattr(item, 'binding', None)
    role = getattr(binding, 'role', None)
    reference = (getattr(binding, 'objectRef', None) if role == 'material'
                 else getattr(binding, 'materialOverride', None) if role == 'generation'
                 else None)
    asset_id = getattr(reference, 'assetId', None)
    return [str(asset_id)] if asset_id is not None else []


def _run_id(asset: Any) -> str:
    provenance = getattr(asset, 'provenance', None)
    return str(getattr(provenance, 'agentRunId', '') or '')


def _node_result(item: Any, result: dict) -> dict:
    visible = bool(getattr(item, 'visible', True))
    return {**result,
            'status': 'focused' if visible else 'hidden',
            'nodeId': str(getattr(item, 'id', '')),
            'kind': str(getattr(item, 'kind', '')),
            **({} if visible else {'action': 'reveal'})}


def _node_candidate(item: Any) -> dict:
    visible = bool(getattr(item, 'visible', True))
    return {'nodeId': str(getattr(item, 'id', '')),
            'kind': str(getattr(item, 'kind', '')),
            'title': str(getattr(item, 'title', '')),
            'hidden': not visible}


def _asset_candidate(asset: Any) -> dict:
    return {'assetId': str(getattr(asset, 'id', '')),
            'kind': str(getattr(asset, 'kind', '')),
            'title': str(getattr(asset, 'name', ''))}


def _unique(items: list[Any]) -> list[Any]:
    seen: set[str] = set()
    result = []
    for item in items:
        identity = str(getattr(item, 'id', ''))
        if identity not in seen:
            seen.add(identity)
            result.append(item)
    return result


def _resolve_name(name: str, snapshot: Any, turn_id: str | None, result: dict) -> dict:
    assets = [asset for asset in _assets(snapshot) if _asset_matches(name, asset)]
    if assets and turn_id is not None:
        # The turn's own outputs take precedence over an unrelated asset that
        # happens to share a file name. A filename alone never picks silently.
        current = [asset for asset in assets if _run_id(asset) == str(turn_id)]
        if current:
            assets = current
    if assets:
        asset_ids = {str(getattr(asset, 'id', '')) for asset in assets}
        nodes = _unique([item for item in _items(snapshot)
                         if asset_ids.intersection(_binding_asset_ids(item))])
        if len(assets) == 1 and len(nodes) == 1:
            return _node_result(nodes[0], result)
        if len(assets) == 1 and not nodes:
            asset = assets[0]
            return {**result, 'status': 'materialize',
                    'assetId': str(getattr(asset, 'id', '')),
                    'kind': str(getattr(asset, 'kind', '')),
                    'action': 'materialize'}
        return {**result, 'status': 'ambiguous',
                'candidates': [*map(_asset_candidate, assets), *map(_node_candidate, nodes)]}
    nodes = _unique([item for item in _items(snapshot)
                     if str(getattr(item, 'title', '')) == name])
    if len(nodes) == 1:
        return _node_result(nodes[0], result)
    if len(nodes) > 1:
        return {**result, 'status': 'ambiguous',
                'candidates': [_node_candidate(item) for item in nodes]}
    return {**result, 'status': 'missing'}


def resolve_canvas_link(target: str, snapshot: Any, turn_id: str | None = None) -> dict:
    """Resolve one destination to a typed, JSON-serializable outcome."""
    raw = str(target)
    result = {'target': raw}
    try:
        kind, value = _identity(raw)
        if kind == 'external':
            return {**result, 'status': 'external'}
        if kind == 'missing':
            return {**result, 'status': 'missing'}
        if kind == 'project':
            project_id, node_id = value
            if project_id != _project_id(snapshot):
                return {**result, 'status': 'cross-project',
                        'projectId': project_id, 'nodeId': node_id}
            item = next((item for item in _items(snapshot)
                         if str(getattr(item, 'id', '')) == node_id), None)
            return _node_result(item, result) if item is not None else {**result, 'status': 'missing'}
        if kind == 'node':
            item = next((item for item in _items(snapshot)
                         if str(getattr(item, 'id', '')) == value), None)
            return _node_result(item, result) if item is not None else {**result, 'status': 'missing'}
        return _resolve_name(value, snapshot, turn_id, result)
    except Exception:
        # A malformed project fact or an unexpected snapshot shape must not
        # break an assistant reply; the link simply stays unresolved.
        return {**result, 'status': 'missing'}


def canvas_links_for_text(text: str, snapshot: Any, turn_id: str | None = None) -> list[dict]:
    """Resolve each unique inline link, omitting ordinary external URLs."""
    result: list[dict] = []
    seen: set[str] = set()
    for target in link_targets(text):
        if target in seen:
            continue
        seen.add(target)
        resolved = resolve_canvas_link(target, snapshot, turn_id)
        if resolved['status'] != 'external':
            result.append(resolved)
    return result


def with_canvas_links(message: Mapping[str, Any], snapshot: Any,
                      turn_id: str | None = None) -> dict:
    """Attach resolved references to an assistant message before persistence."""
    value = dict(message)
    if value.get('role') != 'assistant':
        return value
    links = canvas_links_for_text(str(value.get('text', '')), snapshot, turn_id)
    if links:
        value['canvasLinks'] = links
    return value
