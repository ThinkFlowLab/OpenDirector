"""Select checks from the whole PR, merge group or push; fail closed on unknowns."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess


ROOT_DOCUMENTS = {'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CHANGELOG.md'}
DOCUMENT_SUFFIXES = {'.md', '.png', '.jpg', '.jpeg', '.gif', '.webp'}
REASONS = {
    'docs_only': 'Documentation only; heavy checks skipped / 纯文档，跳过重检查',
    'non_documentation': 'Code, configuration or other inputs changed / 代码、配置或其他输入有变更',
    'comparison_unavailable': 'Diff could not be proven; run full checks / 无法确认差异，运行完整检查',
    'empty_diff': 'Empty diff; run full checks / 差异为空，运行完整检查',
    'event_requires_full': 'This event requires full checks / 本事件要求完整检查',
    'plugin_changed': 'Plugin or its check inputs changed / 插件或其检查输入有变更',
    'plugin_unchanged': 'No plugin check inputs changed; tests skipped / 插件检查输入未变，跳过测试',
}


def documentation(path):
    if path in ROOT_DOCUMENTS:
        return True
    if not path.startswith('docs/') or '\\' in path or any(part in {'', '.', '..'} for part in path.split('/')):
        return False
    return PurePosixPath(path).suffix.lower() in DOCUMENT_SUFFIXES


def changed_paths(event, base, *, head=None, repository=None):
    """Return all changed paths, or None when the range cannot be proven."""
    if not re.fullmatch(r'[0-9a-f]{40}', base or ''):
        return None
    try:
        if event == 'merge_group':
            if not re.fullmatch(r'[0-9a-f]{40}', head or ''):
                return None
            actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repository,
                                            stderr=subprocess.DEVNULL, timeout=30).decode().strip()
            if actual != head:
                return None
            subprocess.check_output(['git', 'merge-base', '--is-ancestor', base, head],
                                    cwd=repository, stderr=subprocess.DEVNULL, timeout=30)
        # PRs use the merge base; queues use the event's base through the entire
        # synthetic head, including preceding PRs. Keep both sides of renames.
        comparison = base + ('...HEAD' if event == 'pull_request' else '..HEAD')
        diff = subprocess.check_output(
            ['git', 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', comparison, '--'],
            cwd=repository, stderr=subprocess.DEVNULL, timeout=30,
        )
        if diff and not diff.endswith(b'\0'):
            return None
        return diff.decode('utf-8').rstrip('\0').split('\0') if diff else []
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return None


def select(event, base, *, head=None, repository=None):
    result = {'run-heavy': 'true', 'scope-reason': 'event_requires_full', 'changed-files': '0'}
    if event not in {'pull_request', 'merge_group'}:
        return result
    result['scope-reason'] = 'comparison_unavailable'
    paths = changed_paths(event, base, head=head, repository=repository)
    if paths is None:
        return result
    result['changed-files'] = str(len(paths))
    if not paths:
        result['scope-reason'] = 'empty_diff'
    elif all(documentation(path) for path in paths):
        result.update({'run-heavy': 'false', 'scope-reason': 'docs_only'})
    else:
        result['scope-reason'] = 'non_documentation'
    return result


def select_dsh(event, base, *, head=None, repository=None):
    result = {'run-dsh': 'true', 'scope-reason': 'event_requires_full', 'changed-files': '0'}
    if event not in {'pull_request', 'merge_group', 'push'}:
        return result
    paths = changed_paths(event, base, head=head, repository=repository)
    if paths is None:
        result['scope-reason'] = 'comparison_unavailable'
    elif not paths:
        result['scope-reason'] = 'empty_diff'
    else:
        result['changed-files'] = str(len(paths))
        relevant = any(path.startswith('plugins/deepseek-harness/') or path in {
            '.github/workflows/dsh-plugin.yml', '.nvmrc', 'scripts/ci/select_checks.py',
        } for path in paths)
        result.update({'run-dsh': 'true' if relevant else 'false',
                       'scope-reason': 'plugin_changed' if relevant else 'plugin_unchanged'})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dsh', action='store_true', help='Select plugin checks / 判断插件检查范围')
    args = parser.parse_args()
    event = os.environ.get('GITHUB_EVENT_NAME')
    base = os.environ.get({'merge_group': 'MERGE_GROUP_BASE_SHA', 'push': 'PUSH_BASE_SHA'}.get(event, 'PR_BASE_SHA'))
    selector = select_dsh if args.dsh else select
    result = selector(event, base, head=os.environ.get('GITHUB_SHA'))
    print(json.dumps(result))
    if path := os.environ.get('GITHUB_OUTPUT'):
        with Path(path).open('a', encoding='utf-8') as output:
            output.writelines(f'{key}={value}\n' for key, value in result.items())
    if path := os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(path).open('a', encoding='utf-8') as output:
            output.write('## Check scope / 检查范围\n\n' + REASONS[result['scope-reason']]
                         + '\n\nChanged paths / 变更路径数: ' + result['changed-files'] + '\n')


if __name__ == '__main__':
    main()
