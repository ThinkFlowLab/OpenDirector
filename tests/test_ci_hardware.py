"""Check static mark validation without importing or modifying test modules."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


pytestmark = [pytest.mark.ready, pytest.mark.cpu]
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('mark_check', ROOT / 'scripts/pre-commit/check_test_marks.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
KNOWN = checker.HARDWARE | checker.LAYERS | checker.BUILTINS


def test_module_class_function_and_parameter_marks_are_inherited():
    source = '''import pytest
raise RuntimeError('static checks must never import this module')
pytestmark = pytest.mark.cpu
@pytest.mark.merge
class TestExample:
    @pytest.mark.parametrize('value', [1, 2])
    def test_save(self, value): pass
'''
    assert checker.check_python(source, KNOWN) == []


@pytest.mark.parametrize('decorators', [
    '@pytest.mark.cpu',
    '@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.cpu)])',
])
def test_function_and_parameter_platforms_are_accepted(decorators):
    assert checker.check_python('import pytest\n' + decorators + '\ndef test_sample(value=None): pass\n', KNOWN) == []


@pytest.mark.parametrize('source,diagnostic', [
    ('def test_missing(): pass', 'exactly one hardware'),
    ('@pytest.mark.cpou\ndef test_typo(): pass', 'unknown mark'),
    ('@pytest.mark.gpu\ndef test_removed(): pass', 'unknown mark'),
    ('pytestmark = pytest.mark.cpu\n@pytest.mark.cuda\ndef test_conflict(): pass', 'exactly one hardware'),
    ('pytestmark = [pytest.mark.cpu, pytest.mark.merge]\n@pytest.mark.ready\ndef test_conflict(): pass', 'conflicting CI'),
    ('@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.cpu), 2])\ndef test_partial(value): pass', 'exactly one hardware'),
    ('pytestmark = pytest.mark.cpu\n@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.cuda)])\ndef test_conflict(value): pass', 'exactly one hardware'),
])
def test_missing_typo_conflicting_and_partial_marks_fail(source, diagnostic):
    assert any(diagnostic in problem for problem in checker.check_python('import pytest\n' + source, KNOWN))


def test_unmarked_ci_layer_migration_is_not_a_hardware_default():
    assert checker.check_python('import pytest\npytestmark = pytest.mark.cpu\ndef test_old(): pass', KNOWN) == []
    assert checker.check_python('import pytest\n@pytest.mark.ready\ndef test_new(): pass', KNOWN)


@pytest.mark.parametrize('entry', [
    {'file': 'one.test.ts'},
    {'file': 'one.test.ts', 'layer': 'ready'},
    {'file': 'one.test.ts', 'layer': 'read', 'hardware': 'cpu'},
    {'file': 'one.test.ts', 'layer': 'ready', 'hardware': 'cpou'},
])
def test_catalogs_require_explicit_known_axes(entry):
    assert checker.check_catalog([entry])


def test_helpers_cannot_be_marked_as_executable_tests():
    assert checker.check_catalog([{'file': 'helper.mjs', 'helper': True}], browser=True) == []
    assert checker.check_catalog([{'file': 'helper.mjs', 'helper': True, 'hardware': 'cpu'}], browser=True)


def test_repository_marks_pass_static_validation():
    assert checker.audit() == []


def test_pytest_does_not_add_cpu_to_unmarked_cases(tmp_path):
    sample = tmp_path / 'test_sample.py'
    sample.write_text('def test_unmarked(): pass\n', encoding='utf-8')
    result = subprocess.run([
        sys.executable, '-m', 'pytest', str(sample), '--noconftest',
        '-c', str(ROOT / 'pyproject.toml'), '--collect-only', '-q', '-m', 'cpu',
    ], capture_output=True, text=True, encoding='utf-8', timeout=30)
    assert result.returncode == 5, result.stdout + result.stderr


@pytest.mark.parametrize('scenario,expected,diagnostic', [
    ('valid', 0, 'Explicit test marks OK'),
    ('missing_python_hardware', 1, 'exactly one hardware'),
    ('unknown_python_hardware', 1, 'unknown mark'),
    ('conflicting_python_hardware', 1, 'exactly one hardware'),
    ('conflicting_python_layers', 1, 'conflicting CI layers'),
    ('partial_parameter_hardware', 1, 'exactly one hardware'),
    ('missing_unit_hardware', 1, 'explicit valid layer and hardware'),
    ('unknown_browser_hardware', 1, 'explicit valid layer and hardware'),
    ('missing_unit_registration', 1, 'Unit inventory differs'),
    ('marked_helper', 1, 'helper carries test marks'),
])
def test_cli_checks_constructed_files_without_importing_tests(tmp_path, scenario, expected, diagnostic):
    scripts = tmp_path / 'scripts/pre-commit'
    scripts.mkdir(parents=True)
    shutil.copyfile(ROOT / 'scripts/pre-commit/check_test_marks.py', scripts / 'check_test_marks.py')
    shutil.copyfile(ROOT / 'pyproject.toml', tmp_path / 'pyproject.toml')
    tests = tmp_path / 'tests'
    (tests / 'browser').mkdir(parents=True)
    source = "import pytest\npytestmark = pytest.mark.cpu\nraise RuntimeError('must not import')\ndef test_sample(): pass\n"
    unit = {'file': 'one.test.ts', 'layer': 'ready', 'hardware': 'cpu'}
    browser = {'file': 'one.mjs', 'layer': 'ready', 'hardware': 'cpu', 'lanes': ['gate']}
    if scenario == 'missing_python_hardware':
        source = 'def test_missing(): pass\n'
    elif scenario == 'unknown_python_hardware':
        source = 'import pytest\n@pytest.mark.gpu\ndef test_removed(): pass\n'
    elif scenario == 'conflicting_python_hardware':
        source = 'import pytest\npytestmark = pytest.mark.cpu\n@pytest.mark.cuda\ndef test_conflict(): pass\n'
    elif scenario == 'conflicting_python_layers':
        source = 'import pytest\npytestmark = [pytest.mark.cpu, pytest.mark.ready]\n@pytest.mark.merge\ndef test_conflict(): pass\n'
    elif scenario == 'partial_parameter_hardware':
        source = 'import pytest\n@pytest.mark.parametrize("x", [pytest.param(1, marks=pytest.mark.cpu), 2])\ndef test_partial(x): pass\n'
    elif scenario == 'missing_unit_hardware':
        del unit['hardware']
    elif scenario == 'unknown_browser_hardware':
        browser['hardware'] = 'gpu'
    elif scenario == 'marked_helper':
        browser['helper'] = True
    (tests / 'test_sample.py').write_text(source, encoding='utf-8')
    (tests / 'one.test.ts').write_text("throw new Error('must not execute');\n", encoding='utf-8')
    (tests / 'browser/one.mjs').write_text("throw new Error('must not execute');\n", encoding='utf-8')
    (tests / 'frontend-manifest.json').write_text(json.dumps({
        'schemaVersion': 1, 'tests': [] if scenario == 'missing_unit_registration' else [unit],
    }), encoding='utf-8')
    (tests / 'browser/manifest.json').write_text(json.dumps({'scripts': [browser]}), encoding='utf-8')
    result = subprocess.run([sys.executable, str(scripts / 'check_test_marks.py')],
        cwd=tmp_path, capture_output=True, text=True, encoding='utf-8', timeout=30,
        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    assert result.returncode == expected, result.stdout + result.stderr
    assert diagnostic in result.stdout, result.stdout + result.stderr
    assert 'must not import' not in result.stdout + result.stderr
