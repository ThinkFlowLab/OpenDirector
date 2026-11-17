"""Resolve assistant Markdown links to stable canvas item identities.

An assistant reply may link to canvas content with a relative destination such
as ``[Finished video](output.mp4)``. The file name is matched against project
assets and their recorded provenance, then mapped to the canvas items that
display the asset. The result stores only stable object identities and typed
status codes; current geometry is deliberately not stored, so moving, renaming
or regrouping an item never invalidates a saved link.

Markdown links (including reference-style links) and plain @title mentions are
considered. Code, images and ordinary external URLs are left untouched. Item
titles resolve only through @title mentions; a bare link destination matches
asset names, not item titles.
"""
from __future__ import annotations

from typing import Any, Mapping
import re
from urllib.parse import unquote, urlsplit
from uuid import UUID
from markdown_it import MarkdownIt

LINK_STATUSES = ('focused', 'hidden', 'materialize', 'ambiguous', 'missing',
                 'cross-project', 'external')

def link_targets(text: str) -> list[str]:
    """Extract renderer-compatible link destinations, excluding images/code."""
    targets: list[str] = []
    for token in MarkdownIt().parse(text):
        if token.type != 'inline' or not token.children:
            continue
        for child in token.children:
            if child.type == 'link_open' and child.attrs:
                href = child.attrs.get('href')
                if href is not None and str(href).strip():
                    targets.append(str(href))
    return targets


# Full-width punctuation that always ends a mention, even mid-sentence:
# "\u53c2\u89c1@\u6807\u9898\u3001\u7136\u540e\u7ee7\u7eed", "\u201c@\u6807\u9898\u201d\u6548\u679c\u4e0d\u9519", "\uff08@\u6807\u9898\uff09\u8bf7\u7ee7\u7eed".
_MENTION_END_ANY = '\u3001\u201d\u2026\u2014\uff09\u300d\u300f\u3011\u300b\u3009'
# ASCII sentence punctuation only ends a mention at the end of the text or
# before whitespace, so a title such as ``Chapter 2.1`` keeps its punctuation.
_MENTION_END_AFTER_SPACE = '.:"\'\uff1a'


def _boundary_indexes(value: str) -> list[int]:
    """Indexes where sentence punctuation ends a mention."""
    indexes = []
    for index, char in enumerate(value):
        if char in _MENTION_END_ANY:
            indexes.append(index)
        elif char in _MENTION_END_AFTER_SPACE and (
                index + 1 == len(value) or value[index + 1].isspace()):
            indexes.append(index)
    return indexes


def _mention_base(value: str) -> str:
    """Trim a mention at the first sentence punctuation that ends it.

    A period or colon followed by whitespace (or the end of the text) ends the
    mention, so ``@Finished note. Next step`` resolves ``Finished note``. An
    internal period such as ``Chapter 2.1`` stays part of the title because it
    is not followed by whitespace. Full-width closing punctuation ends the
    mention wherever it appears.
    """
    value = value.strip()
    indexes = _boundary_indexes(value)
    return value[:indexes[0]].rstrip() if indexes else value.rstrip()


def _mention_targets(text: str) -> list[str]:
    targets = []
    for token in MarkdownIt().parse(text):
        if token.type != 'inline' or not token.children:
            continue
        in_link = False
        for child in token.children:
            if child.type == 'link_open':
                in_link = True
            elif child.type == 'link_close':
                in_link = False
            elif child.type == 'text' and not in_link:
                # The word boundary is ASCII-only, matching JavaScript's \w:
                # CJK prose directly before a mention is not glued to it.
                # Hard sentence punctuation ends the run here; softer trailing
                # punctuation (period/colon/full-width closers) is kept in the
                # raw mention so an exact title such as "@Dr. Smith" can win
                # before the resolver trims it.
                for match in re.finditer(
                        r"(?<![A-Za-z0-9_])@([^@\n,;!?()[\]{}<>`\u3002\uff1b\uff0c\uff01\uff1f\uff1a]+)",
                        child.content):
                    targets.append('@' + match.group(1).strip())
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
    if raw.startswith('@'):
        return 'title', raw[1:].strip()
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
    name = path
    if not name or name.rsplit('/', 1)[-1] in {'.', '..'}:
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
    if '/' in name:
        # A directory-qualified destination must match the full name/path; a
        # same-basename file in another directory is a different object.
        return name in {str(getattr(asset, 'name', '') or '').replace('\\', '/'),
                        str(getattr(asset, 'path', '') or '').replace('\\', '/')}
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


def _effective_visibility(item: Any, items: tuple[Any, ...]) -> bool:
    by_id = {str(getattr(value, 'id', '')): value for value in items}
    current = item
    seen: set[str] = set()
    while current is not None:
        identity = str(getattr(current, 'id', ''))
        if identity in seen or not bool(getattr(current, 'visible', True)):
            return False
        seen.add(identity)
        parent = getattr(current, 'parentId', None)
        current = by_id.get(str(parent)) if parent else None
    return True


def _resolved_node(item: Any, snapshot: Any, result: dict) -> dict:
    output = _node_result(item, result)
    visible = _effective_visibility(item, _items(snapshot))
    output['status'] = 'focused' if visible else 'hidden'
    if visible:
        output.pop('action', None)
    else:
        output['action'] = 'reveal'
    return output


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
    # An adopted generation node displays the asset selected by its current
    # result even though its binding remains a generation spec.
    results = {str(getattr(result_version, 'id', '')): result_version
               for result_version in (getattr(snapshot, 'results', ()) or ())}
    specs = {str(getattr(spec, 'id', '')): spec
             for spec in (getattr(snapshot, 'generationSpecs', ()) or ())}
    for item in _items(snapshot):
        binding = getattr(item, 'binding', None)
        if getattr(binding, 'role', None) != 'generation' or getattr(binding, 'materialOverride', None) is not None:
            continue
        spec_ref = (getattr(binding, 'spec', None) or getattr(binding, 'generationSpec', None)
                    or getattr(binding, 'objectRef', None))
        spec = specs.get(str(getattr(spec_ref, 'id', '')))
        selected = results.get(str(getattr(spec, 'currentResultId', '')))
        asset_ref = getattr(selected, 'asset', None)
        asset_id = getattr(asset_ref, 'assetId', None)
        asset = next((value for value in _assets(snapshot) if str(getattr(value, 'id', '')) == str(asset_id)), None)
        if asset is not None and _asset_matches(name, asset) and asset not in assets:
            assets.append(asset)
    if turn_id is not None and len(assets) > 1:
        # A filename shared by several assets in a turn identifies only that
        # turn's output; a single asset (a user import or an earlier turn's
        # result) still resolves by name.
        assets = [asset for asset in assets if _run_id(asset) == str(turn_id)]
        if not assets:
            return {**result, 'status': 'missing'}
    if assets:
        asset_ids = {str(getattr(asset, 'id', '')) for asset in assets}
        result_assets: dict[str, str] = {}
        results = {str(getattr(value, 'id', '')): value
                   for value in (getattr(snapshot, 'results', ()) or ())}
        specs = {str(getattr(value, 'id', '')): value
                 for value in (getattr(snapshot, 'generationSpecs', ()) or ())}
        for item in _items(snapshot):
            binding = getattr(item, 'binding', None)
            if getattr(binding, 'role', None) != 'generation' or getattr(binding, 'materialOverride', None) is not None:
                continue
            spec_ref = (getattr(binding, 'spec', None) or getattr(binding, 'generationSpec', None)
                        or getattr(binding, 'objectRef', None))
            spec = specs.get(str(getattr(spec_ref, 'id', '')))
            selected = results.get(str(getattr(spec, 'currentResultId', '')))
            asset_ref = getattr(selected, 'asset', None)
            selected_id = getattr(asset_ref, 'assetId', None)
            if selected_id is not None:
                result_assets[str(getattr(item, 'id', ''))] = str(selected_id)
        nodes = _unique([item for item in _items(snapshot)
                         if asset_ids.intersection(_binding_asset_ids(item)) or
                         result_assets.get(str(getattr(item, 'id', ''))) in asset_ids])
        if len(assets) == 1 and len(nodes) == 1:
            return _resolved_node(nodes[0], snapshot, result)
        if len(assets) == 1 and not nodes:
            asset = assets[0]
            return {**result, 'status': 'materialize',
                    'assetId': str(getattr(asset, 'id', '')),
                    'kind': str(getattr(asset, 'kind', '')),
                    'action': 'materialize'}
        return {**result, 'status': 'ambiguous',
                'candidates': [*map(_asset_candidate, assets), *map(_node_candidate, nodes)]}
    return {**result, 'status': 'missing'}


_PROSE_WORD = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*\Z")
_CJK_CHARACTER = re.compile('[㐀-䶿一-鿿豈-﫿'
                            '぀-ヿ가-힯]')


def _prose_drops(value: str) -> list[str]:
    """Trailing ordinary prose words removed one at a time, longest first.

    A number or label such as "@Scene 99 does not exist" may be part of a real
    title, so only an ordinary word is dropped; resolving the shorter node
    "Scene" would reference the wrong object.
    """
    drops = []
    candidate = value
    while candidate:
        head, _, tail = candidate.rpartition(' ')
        if not head or not _PROSE_WORD.fullmatch(tail):
            break
        candidate = head
        drops.append(candidate)
    return drops


def _punctuation_prefixes(value: str) -> list[str]:
    """Mention prefixes cut at every sentence-punctuation boundary, longest first.

    Trying the longest first keeps an internal punctuation mark that belongs
    to the title: ``@Dr. Smith.`` must try ``Dr. Smith`` before ``Dr``.
    """
    value = value.strip()
    prefixes: list[str] = []
    for index in _boundary_indexes(value):
        prefix = value[:index].rstrip()
        if prefix and prefix not in prefixes:
            prefixes.append(prefix)
    return sorted(prefixes, key=len, reverse=True)


def _title_candidates(value: str) -> list[str]:
    """Ordered title candidates for a raw mention, most specific first.

    The untrimmed mention is tried first so an exact title that itself
    contains sentence punctuation ("@Dr. Smith", "@Note: Intro") is never
    truncated to a shorter, different node. Trailing prose is dropped before
    punctuation trimming: in "@Dr. Smith says hello" the period after "Dr" is
    part of the title, so the full "Dr. Smith" candidate must be tried before
    the shorter "Dr" boundary prefix.
    """
    candidates: list[str] = []

    def add(candidate: str) -> None:
        candidate = candidate.strip()
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    add(value)
    for candidate in _prose_drops(value):
        add(candidate)
    prefixes = _punctuation_prefixes(value)
    for prefix in prefixes:
        add(prefix)
    for prefix in prefixes:
        for candidate in _prose_drops(prefix):
            add(candidate)
    return candidates


def _known_title_prefix(name: str, snapshot: Any) -> str | None:
    """Longest known title that starts a mention running into CJK prose.

    Chinese prose has no spaces, so ``用@标题生成视频`` swallows the following
    sentence into the mention. Only a CJK continuation enables this fallback;
    an ASCII continuation (``@Scene 99``) stays unresolved rather than
    referencing the unrelated shorter node ``Scene``.
    """
    best = None
    for item in _items(snapshot):
        title = str(getattr(item, 'title', '') or '')
        if not title or len(title) >= len(name) or not name.startswith(title):
            continue
        if not _CJK_CHARACTER.match(name[len(title):]):
            continue
        if best is None or len(title) > len(best):
            best = title
    return best


def _resolve_title(name: str, snapshot: Any, result: dict) -> dict:
    candidates = _title_candidates(name)
    prefix = _known_title_prefix(name, snapshot)
    if prefix is not None and prefix not in candidates:
        candidates.append(prefix)
    for candidate in candidates:
        nodes = _unique([item for item in _items(snapshot)
                         if str(getattr(item, 'title', '')) == candidate])
        if len(nodes) == 1:
            return _resolved_node(nodes[0], snapshot, {**result, 'target': '@' + candidate})
        if len(nodes) > 1:
            return {**result, 'target': '@' + candidate, 'status': 'ambiguous',
                    'candidates': [_node_candidate(item) for item in nodes]}
    # Keep the persisted target on the mention itself so the renderer never
    # turns the rest of the sentence ("@No such item. Next step") into one
    # clickable reference. A raw mention with no boundary keeps its full text.
    base = _mention_base(name)
    return {**result, 'target': '@' + base if base else result['target'],
            'status': 'missing'}


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
        if kind == 'title':
            return _resolve_title(value, snapshot, result)
        if kind == 'project':
            project_id, node_id = value
            if project_id != _project_id(snapshot):
                return {**result, 'status': 'cross-project',
                        'projectId': project_id, 'nodeId': node_id}
            item = next((item for item in _items(snapshot)
                         if str(getattr(item, 'id', '')) == node_id), None)
            return _resolved_node(item, snapshot, result) if item is not None else {**result, 'status': 'missing'}
        if kind == 'node':
            item = next((item for item in _items(snapshot)
                         if str(getattr(item, 'id', '')) == value), None)
            return _resolved_node(item, snapshot, result) if item is not None else {**result, 'status': 'missing'}
        return _resolve_name(value, snapshot, turn_id, result)
    except Exception:
        # A malformed project fact or an unexpected snapshot shape must not
        # break an assistant reply; the link simply stays unresolved.
        return {**result, 'status': 'missing'}


def canvas_links_for_text(text: str, snapshot: Any, turn_id: str | None = None) -> list[dict]:
    """Resolve each unique inline link, omitting ordinary external URLs."""
    result: list[dict] = []
    seen: set[str] = set()
    for target in [*link_targets(text), *_mention_targets(text)]:
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
