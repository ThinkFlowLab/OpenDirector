"""Project-local source metadata derived from native search execution evidence."""
from functools import lru_cache
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from uuid import UUID, uuid5


_REF = re.compile(r'turn\d+(?:search|view|news)\d+')
_HEADING = re.compile(r'^([^\n]+) \((https?://[^\n]+)\)\n【(turn\d+(?:search|view|news)\d+)】', re.MULTILINE)


def referenced_sources(text: str, sources: dict[str, dict]) -> list[dict]:
    return [sources[ref] for ref in dict.fromkeys(_REF.findall(text)) if ref in sources]


def _source(ref, url, title) -> dict | None:
    if not isinstance(ref, str) or not _REF.fullmatch(ref) or not isinstance(url, str):
        return None
    try:
        parsed = urlsplit(url)
        if (parsed.scheme not in {'http', 'https'} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or re.search(r'[\x00-\x20\x7f]', url)):
            return None
    except ValueError:
        return None
    return {'id': ref, 'url': url, 'title': title if isinstance(title, str) and title.strip() else parsed.hostname}


def search_sources(raw: dict) -> list[dict]:
    """Accept completed native search results, never assistant-authored URLs."""
    item = raw.get('item')
    if (raw.get('type') != 'item.completed' or not isinstance(item, dict) or item.get('type') != 'mcp_tool_call'
            or item.get('status') != 'completed' or item.get('error')
            or item.get('tool') not in {'search_service.web_run', 'web.run', 'web_run'}):
        return []
    result = item.get('result')
    if not isinstance(result, dict) or result.get('isError'):
        return []
    sources = {}
    # The connected search tool carries explicit ref_id/url/title metadata.
    meta = result.get('_meta') or {}
    messages = meta.get('raw_messages') if isinstance(meta, dict) else None
    for message in messages if isinstance(messages, list) else []:
        content = message.get('content', {}) if isinstance(message, dict) else {}
        if not isinstance(content, dict):
            continue
        source = _source(content.get('ref_id'), content.get('url'), content.get('title'))
        if source:
            sources.setdefault(source['id'], source)
    # Plain MCP search results may omit metadata but retain result headings.
    blocks = result.get('content')
    for block in blocks if isinstance(blocks, list) else []:
        if not isinstance(block, dict) or block.get('type') != 'text' or not isinstance(block.get('text'), str):
            continue
        for title, url, ref in _HEADING.findall(block['text']):
            source = _source(ref, url, title)
            if source:
                sources.setdefault(ref, source)
    return list(sources.values())


@lru_cache(maxsize=128)
def _trace_sources(path: str, modified: int, size: int) -> tuple[dict, ...]:
    """Cache only derived metadata, invalidated when the source trace changes."""
    sources = {}
    with Path(path).open(encoding='utf-8') as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict) or not isinstance(record.get('native'), dict):
                continue
            for source in search_sources(record['native']):
                sources.setdefault(source['id'], source)
    return tuple(sources.values())


def with_trace_sources(conversation: dict, directory: Path) -> dict:
    """Enrich supported historical replies on read without rewriting evidence."""
    messages = []
    turn = None
    known = {}
    for message in conversation.get('messages', []):
        if message.get('role') == 'user':
            try:
                turn = UUID(message['id'])
            except (ValueError, KeyError, TypeError):
                turn = None
        elif (turn is not None and message.get('role') == 'assistant'
                and message.get('id') == str(uuid5(turn, 'assistant'))
                and message.get('runtime') == 'codex' and 'sources' not in message
                and '\ue200' in message.get('text', '')):
            file = directory / 'agent-runs' / f'{turn}.codex.jsonl'
            try:
                if file.parent.is_symlink() or file.is_symlink():
                    raise OSError('Untrusted trace path')
                stat = file.stat()
                sources = _trace_sources(str(file), stat.st_mtime_ns, stat.st_size)
            except (OSError, UnicodeError):
                sources = ()
            refs = set(_REF.findall(message['text']))
            available = {**known, **{source['id']: source for source in sources}}
            message = {**message, 'sources': [dict(source) for ref, source in available.items() if ref in refs]}
        if message.get('role') == 'assistant':
            known.update({source['id']: source for source in message.get('sources', [])})
        messages.append(message)
    return {**conversation, 'messages': messages}
