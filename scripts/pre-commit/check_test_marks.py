"""Check explicit Python hardware marks and JS/TS catalogs without importing tests."""
import ast
import itertools
import json
from pathlib import Path
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[2]
HARDWARE = {'cpu', 'cuda', 'rocm', 'xpu', 'npu'}
LAYERS = {'ready', 'merge', 'nightly'}
BUILTINS = {'parametrize', 'skip', 'skipif', 'xfail', 'usefixtures', 'filterwarnings', 'anyio'}


def marker(node):
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute) and ast.unparse(node.value) == 'pytest.mark':
        return node.attr
    return None


def marker_list(node):
    if isinstance(node, (ast.List, ast.Tuple)):
        return [name for item in node.elts for name in marker_list(item)]
    name = marker(node)
    if name:
        return [name]
    raise ValueError('Use explicit pytest.mark declarations')


def scope_marks(body):
    values = []
    for node in body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'pytestmark' for target in node.targets):
            values.extend(marker_list(node.value))
    return values


def parameter_groups(decorators):
    groups = []
    for decorator in decorators:
        if marker(decorator) != 'parametrize' or not isinstance(decorator, ast.Call):
            continue
        values = decorator.args[1] if len(decorator.args) > 1 else next(
            (kw.value for kw in decorator.keywords if kw.arg == 'argvalues'), None)
        if not isinstance(values, (ast.List, ast.Tuple)):
            # Dynamic matrices require a statically declared common platform.
            continue
        group = []
        for value in values.elts:
            names = []
            if isinstance(value, ast.Call) and ast.unparse(value.func) == 'pytest.param':
                for keyword in value.keywords:
                    if keyword.arg == 'marks':
                        names.extend(marker_list(keyword.value))
            group.append(names)
        groups.append(group or [[]])
    return groups


def check_python(source, known):
    tree = ast.parse(source)
    problems = []
    for node in ast.walk(tree):
        name = marker(node)
        if name and name not in known:
            problems.append(f'{node.lineno}: unknown mark: {name}')

    def walk(body, inherited):
        inherited = inherited + scope_marks(body)
        for node in body:
            if isinstance(node, ast.ClassDef) and node.name.startswith('Test'):
                walk(node.body, inherited + [name for d in node.decorator_list if (name := marker(d))])
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test_'):
                names = inherited + [name for d in node.decorator_list if (name := marker(d))]
                for combination in itertools.product(*parameter_groups(node.decorator_list)):
                    effective = set(names + [name for group in combination for name in group])
                    if len(effective & HARDWARE) != 1:
                        problems.append(f'{node.lineno}: {node.name}: require exactly one hardware mark')
                    # Preserve the existing unmarked-as-ready CI-layer migration.
                    if len(effective & LAYERS) > 1:
                        problems.append(f'{node.lineno}: {node.name}: conflicting CI layers / CI 层级冲突')
    walk(tree.body, [])
    return sorted(set(problems))


def check_catalog(entries, *, browser=False):
    problems, names = [], set()
    for entry in entries:
        name = entry.get('file')
        if not isinstance(name, str) or name in names:
            problems.append('Invalid or duplicate file: ' + str(name))
        names.add(name)
        if browser and entry.get('helper'):
            if 'layer' in entry or 'hardware' in entry:
                problems.append(f'{name}: helper carries test marks')
            continue
        if entry.get('layer') not in LAYERS or entry.get('hardware') not in HARDWARE:
            problems.append(f'{name}: require explicit valid layer and hardware')
    return problems


def audit(root=ROOT):
    config = tomllib.loads((root / 'pyproject.toml').read_text(encoding='utf-8'))
    registered = {value.split(':', 1)[0].strip() for value in config['tool']['pytest']['ini_options']['markers']}
    known = registered | BUILTINS | {'requires_ffmpeg', 'requires_posix'}
    problems = []
    if not (HARDWARE | LAYERS) <= registered:
        problems.append('Missing registered platform/layer marks')
    for path in sorted((root / 'tests').rglob('test_*.py')):
        try:
            problems.extend(f'{path.relative_to(root)}:{problem}' for problem in check_python(path.read_text(encoding='utf-8'), known))
        except (SyntaxError, ValueError) as error:
            problems.append(f'{path.relative_to(root)}: {error}')
    units = json.loads((root / 'tests/frontend-manifest.json').read_text(encoding='utf-8'))
    if units.get('schemaVersion') != 1:
        problems.append('Unsupported unit catalog schema')
    problems.extend(check_catalog(units['tests']))
    if sorted(entry['file'] for entry in units['tests']) != sorted(path.name for path in (root / 'tests').glob('*.test.ts')):
        problems.append('Unit inventory differs from discovery')
    browser = json.loads((root / 'tests/browser/manifest.json').read_text(encoding='utf-8'))
    problems.extend(check_catalog(browser['scripts'] + browser.get('externalScripts', []), browser=True))
    if sorted(entry['file'] for entry in browser['scripts']) != sorted(path.name for path in (root / 'tests/browser').glob('*.mjs')):
        problems.append('Browser inventory differs from discovery')
    for entry in browser.get('externalScripts', []):
        if entry['file'] != 'scripts/verify_creation_browser.mjs' or not (root / entry['file']).is_file():
            problems.append('Invalid external browser registration')
    return problems


def main():
    try:
        problems = audit()
    except (ValueError, KeyError, TypeError, OSError) as error:
        problems = [str(error)]
    if problems:
        print('Test mark check failed:\n' + '\n'.join(problems))
        return 1
    print('Explicit test marks OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
