"""Audit a full pytest inventory and protect critical PR representatives."""
import argparse
from collections import Counter
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LAYERS = {'ready', 'merge', 'nightly'}


def audit(profile, contract, manifest, *, require_executed=False):
    if profile.get('schema_version') != 1 or contract.get('schema_version') != 1:
        raise ValueError('Unsupported evidence or contract schema')
    scope = profile['metadata']
    if (not profile.get('collection_complete') or scope.get('paths') != ['tests']
            or scope.get('selection') or scope.get('keyword') or profile['deselected_count']
            or scope.get('ignore') or scope.get('ignore_glob')):
        raise ValueError('A complete, unfiltered tests/ inventory is required')
    cases = profile['tests']
    ids = [case['nodeid'] for case in cases]
    if len(ids) != len(set(ids)) or len(ids) != profile['collected_count']:
        raise ValueError('Duplicate or missing collected test identities')
    for case in cases:
        layers = case['explicit_layers']
        if len(layers) > 1 or not set(layers) <= LAYERS:
            raise ValueError('Conflicting or unknown CI layer: ' + case['nodeid'])
        expected = layers[0] if layers else 'ready'
        if case['effective_layer'] != expected or case['migration_default'] != (not layers):
            raise ValueError('Unmarked/layer accounting mismatch: ' + case['nodeid'])
    representatives = set()
    capabilities = set()
    for capability in contract['capabilities']:
        if (capability['id'] in capabilities or not capability['tests']
                or set(capability['labels']) != {'zh-CN', 'en-US'}):
            raise ValueError('Invalid or duplicate capability contract')
        capabilities.add(capability['id'])
        for selector in capability['tests']:
            matched = [case for case in cases if case['nodeid'] == selector
                       or case['nodeid'].startswith(selector + '[')
                       or (selector.endswith('.py') and case['nodeid'].startswith(selector + '::'))]
            if not matched:
                raise ValueError('Missing PR representative: ' + selector)
            for case in matched:
                if case['effective_layer'] != 'ready':
                    raise ValueError('PR representative moved out of ready: ' + case['nodeid'])
                representatives.add(case['nodeid'])
    browser = {entry['file']: entry for entry in manifest['scripts']}
    for filename in contract['browser_gate']:
        if filename not in browser or 'gate' not in browser[filename]['lanes']:
            raise ValueError('Missing browser gate representative: ' + filename)
    outcomes = Counter(case.get('outcome', 'not_run') for case in cases
                       if case['nodeid'] in representatives)
    if require_executed and (not profile.get('complete') or profile.get('exit_status') != 0
                             or set(outcomes) != {'passed'}):
        raise ValueError('PR representative execution is missing, skipped or failed')
    return {
        'tests': len(cases), 'layers': dict(Counter(case['effective_layer'] for case in cases)),
        'unmarked': sum(case['migration_default'] for case in cases),
        'capabilities': len(capabilities), 'representative_cases': len(representatives),
        'representative_outcomes': dict(outcomes),
        'browser_gate': len(contract['browser_gate']),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--require-executed', action='store_true')
    parser.add_argument('--contract', type=Path, default=ROOT / 'tests/ci_ready_contract.json')
    parser.add_argument('--browser-manifest', type=Path, default=ROOT / 'tests/browser/manifest.json')
    args = parser.parse_args()
    try:
        values = [json.loads(path.read_text(encoding='utf-8'))
                  for path in (args.profile, args.contract, args.browser_manifest)]
        result = audit(*values, require_executed=args.require_executed)
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise SystemExit('Layer audit failed / 分层核对失败: ' + str(error)) from None
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
