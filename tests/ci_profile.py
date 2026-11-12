"""Opt-in pytest timing evidence; never changes selection or test outcomes."""
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import subprocess
import time

import pytest


LAYERS = {'ready', 'merge', 'nightly'}


def pytest_addoption(parser):
    parser.addoption('--ci-profile', help='Write test timing and layer evidence as JSON')


def pytest_configure(config):
    if destination := config.getoption('--ci-profile'):
        config.pluginmanager.register(Profile(config, Path(destination)), 'ci-profile-writer')


class Profile:
    def __init__(self, config, destination):
        self.destination = destination
        self.started = time.monotonic()
        self.collected = False
        self.collected_count = 0
        self.deselected_count = 0
        self.cases = {}
        sha = os.environ.get('GITHUB_SHA')
        if not sha:
            try:
                result = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True,
                                        text=True, timeout=10)
                sha = result.stdout.strip() if result.returncode == 0 else None
            except (OSError, subprocess.TimeoutExpired):
                sha = None
        self.metadata = {
            'sha': sha, 'run_id': os.environ.get('GITHUB_RUN_ID'),
            'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
            'job': os.environ.get('GITHUB_JOB'), 'platform': platform.system(),
            'python': platform.python_version(), 'pytest': pytest.__version__,
            'selection': config.option.markexpr,
            'keyword': config.option.keyword, 'paths': config.args,
            'ignore': config.option.ignore, 'ignore_glob': config.option.ignore_glob,
            'started_at': datetime.now(timezone.utc).isoformat(),
        }
        self.write(complete=False, exit_status=None)

    def pytest_collection_finish(self, session):
        self.collected_count = len(session.items)
        for item in session.items:
            layers = sorted({mark.name for mark in item.iter_markers() if mark.name in LAYERS})
            self.cases[item.nodeid] = {
                'nodeid': item.nodeid, 'module': item.nodeid.split('::', 1)[0],
                'explicit_layers': layers, 'effective_layer': layers[0] if len(layers) == 1 else 'ready' if not layers else 'conflict',
                'migration_default': not layers, 'durations': {}, 'outcomes': {},
                'capabilities': sorted({mark.name for mark in item.iter_markers()
                                        if mark.name.startswith('requires_')}),
            }
        self.collected = True
        self.write(complete=False, exit_status=None)

    def pytest_runtest_logreport(self, report):
        case = self.cases.get(report.nodeid)
        if case is not None:
            case['durations'][report.when] = report.duration
            case['outcomes'][report.when] = report.outcome

    def pytest_deselected(self, items):
        self.deselected_count += len(items)

    def pytest_sessionfinish(self, session, exitstatus):
        complete = self.collected and int(exitstatus) in (0, 1)
        self.write(complete=complete, exit_status=int(exitstatus))

    def write(self, *, complete, exit_status):
        cases = []
        modules = defaultdict(float)
        for original in self.cases.values():
            case = dict(original)
            outcomes = case['outcomes']
            case['outcome'] = ('failed' if 'failed' in outcomes.values() else
                               'skipped' if 'skipped' in outcomes.values() else
                               'passed' if outcomes.get('call') == 'passed' else 'not_run')
            case['seconds'] = sum(case['durations'].values())
            cases.append(case)
            modules[case['module']] += case['seconds']
        complete = complete and all(case['outcome'] != 'not_run' for case in cases)
        data = {
            'schema_version': 1, 'metadata': self.metadata, 'complete': complete,
            'collection_complete': self.collected, 'collected_count': self.collected_count,
            'deselected_count': self.deselected_count,
            'exit_status': exit_status, 'wall_seconds': time.monotonic() - self.started,
            'counts': dict(Counter(case['outcome'] for case in cases)),
            'layers': dict(Counter(case['effective_layer'] for case in cases)),
            'unmarked': sum(case['migration_default'] for case in cases),
            'modules': dict(sorted(modules.items(), key=lambda pair: pair[1], reverse=True)),
            'tests': cases,
        }
        self.destination.parent.mkdir(parents=True, exist_ok=True)
        self.destination.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if complete:
            def safe(value):
                return value.replace('`', "'").replace('|', '\\|')
            lines = [f'## Python timings / Python 耗时：{self.destination.stem}', '',
                     f"SHA: `{self.metadata['sha']}`; selection: `{safe(self.metadata['selection'])}`", '',
                     f"Exit status / 退出码: {exit_status}; outcomes / 结果: `{data['counts']}`", '',
                     f"{self.metadata['platform']}; Python {self.metadata['python']}; pytest {self.metadata['pytest']}", '',
                     'Times include setup/call/teardown; exclude dependency installation. / 包含夹具阶段，不含依赖安装。', '',
                     '| Module / 模块 | Seconds / 秒 |', '| --- | ---: |']
            lines.extend(f'| `{safe(module)}` | {seconds:.3f} |' for module, seconds in list(data['modules'].items())[:15])
            lines += ['', '| Test / 用例 | Seconds / 秒 | Outcome / 结果 |', '| --- | ---: | --- |']
            lines.extend(f"| `{safe(case['nodeid'])}` | {case['seconds']:.3f} | {case['outcome']} |"
                         for case in sorted(cases, key=lambda row: row['seconds'], reverse=True)[:20])
            summary = '\n'.join(lines) + '\n'
            self.destination.with_suffix('.md').write_text(summary, encoding='utf-8')
            if target := os.environ.get('GITHUB_STEP_SUMMARY'):
                with Path(target).open('a', encoding='utf-8') as output:
                    output.write(summary)
