"""Skip heavy PR checks only for a proven, nonempty documentation-only diff."""
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
    'event_requires_full': 'Only pull requests may skip heavy checks / 仅 PR 可跳过重检查',
}


def documentation(path):
    if path in ROOT_DOCUMENTS:
        return True
    if not path.startswith('docs/') or '\\' in path or any(part in {'', '.', '..'} for part in path.split('/')):
        return False
    return PurePosixPath(path).suffix.lower() in DOCUMENT_SUFFIXES


def select(event, base, *, repository=None):
    result = {'run-heavy': 'true', 'scope-reason': 'event_requires_full', 'changed-files': '0'}
    if event != 'pull_request':
        return result
    result['scope-reason'] = 'comparison_unavailable'
    if not re.fullmatch(r'[0-9a-f]{40}', base or ''):
        return result
    try:
        # Three dots match the pre-commit PR range. Disabling rename detection
        # retains both old and new paths: code renamed into docs is still code.
        diff = subprocess.check_output(
            ['git', 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base + '...HEAD', '--'],
            cwd=repository, stderr=subprocess.DEVNULL, timeout=30,
        )
        if diff and not diff.endswith(b'\0'):
            return result
        paths = diff.decode('utf-8').rstrip('\0').split('\0') if diff else []
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return result
    result['changed-files'] = str(len(paths))
    if not paths:
        result['scope-reason'] = 'empty_diff'
    elif all(documentation(path) for path in paths):
        result.update({'run-heavy': 'false', 'scope-reason': 'docs_only'})
    else:
        result['scope-reason'] = 'non_documentation'
    return result


def main():
    result = select(os.environ.get('GITHUB_EVENT_NAME'), os.environ.get('PR_BASE_SHA'))
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
