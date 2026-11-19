"""Run the same assertions against the repaired baseline or an in-memory mutant.

PYTHONPATH=/tmp/odstubs:packages/core/src:apps/api/src python3 \
  scripts/verify_canvas_link_mutations.py R1 baseline|mutant
No tracked source is written. Each invocation starts a fresh Python process.
"""
import importlib
from pathlib import Path
import sys

# scripts/opendirector.py must not shadow the installed/source package.
sys.path = [entry for entry in sys.path
            if Path(entry).resolve() != Path(__file__).resolve().parent]

import pytest

CASES = {
    'R1': ('opendirector.agent.canvas_links',
           "assets = [asset for asset in assets if _run_id(asset) == str(turn_id)]",
           'assets = assets', 'relative_link_uses_the_turn_provenance'),
    'R2': ('opendirector.agent.canvas_links',
           " or getattr(binding, 'materialOverride', None) is not None", '', 'material_override_links'),
    'R3a': ('opendirector.agent.canvas_links', 'raw = target.strip()',
            'raw = unquote(target.strip())', 'url_path_is_decoded_once'),
    'R3b': ('opendirector.agent.canvas_links', 'path = unquote(parsed.path)',
            'path = parsed.path', 'url_path_is_decoded_once'),
    'R4': ('opendirector.agent.canvas_links',
           'for target in _mention_targets(text):\n        add(target)',
           'for target in []:\n        add(target)', 'plain_mentions_resolve'),
    'R5': ('opendirector.agent.canvas_links',
           "def _mention_targets(text: str) -> list[str]:\n    targets = []",
           "def _mention_targets(text: str) -> list[str]:\n    targets = ['@Finished note']",
           'mentions_in_code'),
    'R6': ('opendirector.agent.canvas_links', 'for token in MarkdownIt().parse(text):',
           "for token in MarkdownIt().parse(text.split('\\n\\n')[0]):", 'reference_style_markdown'),
    'R7': ('opendirector_api.agent',
           "ChatCanvasLink.model_validate(link).model_dump(mode='json')", 'link',
           'finished_turn_persists'),
    'M2': ('opendirector.agent.canvas_links',
           "visible = _effective_visibility(item, _items(snapshot))", 'visible = True',
           'hidden_materialize_ambiguous or child_under_hidden'),
    'M4': ('opendirector.agent.canvas_links',
           "if token.type != 'inline' or not token.children:",
           "if token.type == 'fence':\n            targets.append('fenced.md')\n        if token.type != 'inline' or not token.children:",
           'code_examples_are_not_navigable'),
}

case, mode = sys.argv[1:]
assert mode in {'baseline', 'mutant'}
name, old, new, selector = CASES[case]
module = importlib.import_module(name)
if mode == 'mutant':
    path = Path(module.__file__)
    source = path.read_text()
    assert old in source, f'{case}: mutation source absent'
    exec(compile(source.replace(old, new), str(path), 'exec'), module.__dict__)
result = pytest.main(['tests/test_canvas_links.py', '-q', '-k', selector, '-p', 'no:cacheprovider'])
print(f'{case} {mode}: pytest exit={result}')
sys.exit(0 if result == (0 if mode == 'baseline' else 1) else 1)
