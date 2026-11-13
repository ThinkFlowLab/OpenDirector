"""Fail the stable required check unless every enabled release lane succeeded."""
import json
import os
from pathlib import Path


def main():
    results = json.loads(os.environ['CHECK_RESULTS'])
    static_enabled = json.loads(os.environ['STATIC_ENABLED'])
    if not isinstance(static_enabled, bool):
        raise SystemExit('STATIC_ENABLED must be a JSON boolean')
    expected = {'static', 'python', 'frontend', 'browser'}
    if set(results) != expected:
        raise SystemExit('Missing or unexpected release-check lanes')
    rows = []
    failed = []
    for name in sorted(expected):
        result = results[name]['result']
        allowed = {'success'}
        if name == 'static' and not static_enabled:
            allowed.add('skipped')
        rows.append(f'| {name} | {result} |')
        if result not in allowed:
            failed.append(name)
    report = '\n'.join([
        '## Release checks / 发布检查', '',
        '| Lane / 检查线 | Result / 结果 |', '| --- | --- |', *rows, '',
    ])
    print(report)
    if path := os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(path).open('a', encoding='utf-8') as output:
            output.write(report)
    if failed:
        raise SystemExit('Release checks failed / 发布检查失败: ' + ', '.join(failed))


if __name__ == '__main__':
    main()
