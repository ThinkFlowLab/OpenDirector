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
    scope = results['static'].get('outputs', {})
    heavy = scope.get('run-heavy', '')
    if heavy not in {'', 'true', 'false'}:
        raise SystemExit('Invalid check-scope decision / 检查范围判定无效')
    docs_only = heavy == 'false'
    if docs_only and not (
        static_enabled and results['static']['result'] == 'success'
        and os.environ.get('GITHUB_EVENT_NAME') in {'pull_request', 'merge_group'}
        and scope.get('scope-reason') == 'docs_only'
        and str(scope.get('changed-files', '')).isdigit()
        and int(scope['changed-files']) > 0
    ):
        raise SystemExit('Unproven documentation-only skip / 无法证明纯文档跳过依据')
    rows = []
    failed = []
    for name in sorted(expected):
        result = results[name]['result']
        allowed = {'success'}
        if docs_only and name != 'static':
            allowed = {'skipped'}
        if name == 'static' and not static_enabled:
            allowed.add('skipped')
        rows.append(f'| {name} | {result} |')
        if result not in allowed:
            failed.append(name)
    report = '\n'.join([
        '## Release checks / 发布检查', '',
        ('Documentation-only PR / merge group: static passed; heavy checks intentionally skipped. / '
         '纯文档 PR / 合并组合：静态通过，按明确范围跳过重检查。' if docs_only
         else 'Full checks required / 需要完整检查'),
        'Scope / 范围: ' + str(scope.get('scope-reason', 'full'))
        + '; changed paths / 变更路径数: ' + str(scope.get('changed-files', 'unknown')), '',
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
