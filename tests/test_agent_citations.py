import json
import os
from uuid import uuid4, uuid5

import pytest

from opendirector.agent.citations import search_sources, with_trace_sources
from opendirector.agent.native import text_events


def search_result(ref='turn1search0', url='https://example.test/a', title='Source A'):
    return {'type': 'item.completed', 'item': {'type': 'mcp_tool_call',
        'tool': 'search_service.web_run', 'status': 'completed',
        'result': {'_meta': {'raw_messages': [{'content': {'ref_id': ref, 'url': url, 'title': title}}]},
            'content': [{'type': 'text', 'text': f'{title} ({url})\n【{ref}】 [wordlim: 200] Text'}]}}}


def test_search_sources_use_metadata_and_plain_result_headings_without_duplicates():
    raw = search_result(title='Source (A)')
    expected = [{'id': 'turn1search0', 'url': 'https://example.test/a', 'title': 'Source (A)'}]
    assert search_sources(raw) == expected
    assert text_events('codex', raw) == [{'type': 'sources', 'sources': expected}]
    del raw['item']['result']['_meta']
    assert search_sources(raw) == expected
    assert text_events('claude', {'type': 'other'}) == []


def test_search_sources_reject_failed_unrelated_and_unsafe_results():
    for raw in ({}, {'type': 'item.completed', 'item': None},
                {'type': 'item.completed', 'item': {'type': 'mcp_tool_call', 'status': 'completed',
                 'tool': 'web.run', 'result': {'content': None, '_meta': {'raw_messages': None}}}}):
        assert search_sources(raw) == []
    for url in ('javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.test',
                'https://example.test/\ninvalid', 'https://[invalid'):
        assert search_sources(search_result(url=url)) == []
    assert search_sources(search_result(ref='not-a-reference')) == []
    for key, value in [('status', 'in_progress'), ('tool', 'unrelated'), ('error', {'message': 'failed'})]:
        raw = search_result()
        raw['item'][key] = value
        assert search_sources(raw) == []
    raw = search_result()
    raw['item']['result']['isError'] = True
    assert search_sources(raw) == []


def test_historical_sources_derive_from_the_matching_turn_without_writing_project(tmp_path):
    turn = uuid4()
    folder = tmp_path / 'agent-runs'
    folder.mkdir()
    trace = folder / f'{turn}.codex.jsonl'
    trace.write_text(json.dumps({'native': search_result()}) + '\n{truncated', encoding='utf-8')
    text = 'Result\ue200cite\ue202turn1search0\ue201'
    conversation = {'messages': [{'id': str(turn), 'role': 'user', 'text': 'Search'},
        {'id': str(uuid5(turn, 'assistant')), 'role': 'assistant', 'runtime': 'codex', 'text': text}]}
    original = trace.read_bytes()
    derived = with_trace_sources(conversation, tmp_path)
    assert derived['messages'][-1]['sources'] == search_sources(search_result())
    assert derived['messages'][-1]['text'] == text
    assert 'sources' not in conversation['messages'][-1]
    assert trace.read_bytes() == original
    # Missing evidence downgrades; another turn's results cannot supply it.
    trace.unlink()
    assert with_trace_sources(conversation, tmp_path)['messages'][-1]['sources'] == []
    trace.write_text(json.dumps({'native': search_result(url='https://example.test/updated')}), encoding='utf-8')
    assert with_trace_sources(conversation, tmp_path)['messages'][-1]['sources'][0]['url'].endswith('/updated')


@pytest.mark.skipif(os.name == 'nt', reason='Trace symlink probe requires POSIX symlink creation')
def test_historical_sources_reuse_prior_turn_evidence_but_do_not_follow_trace_links(tmp_path):
    turn = uuid4()
    source = search_sources(search_result())[0]
    conversation = {'messages': [{'role': 'assistant', 'text': 'Earlier', 'sources': [source]},
        {'id': str(turn), 'role': 'user', 'text': 'Continue'},
        {'id': str(uuid5(turn, 'assistant')), 'role': 'assistant', 'runtime': 'codex',
         'text': 'Again\ue200cite\ue202turn1search0\ue201'}]}
    assert with_trace_sources(conversation, tmp_path)['messages'][-1]['sources'] == [source]
    folder = tmp_path / 'agent-runs'
    folder.mkdir()
    external = tmp_path / 'external.jsonl'
    external.write_text(json.dumps({'native': search_result(ref='turn2view0')}), encoding='utf-8')
    (folder / f'{turn}.codex.jsonl').symlink_to(external)
    conversation['messages'][-1]['text'] = 'Other\ue200cite\ue202turn2view0\ue201'
    assert with_trace_sources(conversation, tmp_path)['messages'][-1]['sources'] == []
