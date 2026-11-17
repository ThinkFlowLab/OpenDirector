"""Protect critical coverage and reject incomplete/misclassified inventories."""
import copy
import importlib.util
from pathlib import Path

import pytest


pytestmark = pytest.mark.ready
spec = importlib.util.spec_from_file_location('layer_audit',
    Path(__file__).resolve().parents[1] / 'scripts/ci/check_test_layers.py')
audit_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_module)


@pytest.fixture
def evidence():
    profile = {
        'schema_version': 1, 'collection_complete': True, 'collected_count': 2,
        'deselected_count': 0,
        'metadata': {'paths': ['tests'], 'selection': '', 'keyword': ''},
        'complete': True, 'exit_status': 0,
        'tests': [
            {'nodeid': 'tests/test_sample.py::test_core[one]', 'explicit_layers': [],
             'effective_layer': 'ready', 'migration_default': True, 'outcome': 'passed'},
            {'nodeid': 'tests/test_sample.py::test_matrix', 'explicit_layers': ['merge'],
             'effective_layer': 'merge', 'migration_default': False, 'outcome': 'passed'},
        ],
    }
    contract = {'schema_version': 1, 'capabilities': [{
        'id': 'core', 'labels': {'zh-CN': '核心', 'en-US': 'Core'},
        'tests': ['tests/test_sample.py::test_core'],
    }], 'browser_gate': ['export.mjs']}
    manifest = {'scripts': [{'file': 'export.mjs', 'lanes': ['gate']}]}
    return profile, contract, manifest


def test_unmarked_representative_and_complete_partition(evidence):
    result = audit_module.audit(*evidence, require_executed=True)
    assert result['layers'] == {'ready': 1, 'merge': 1}
    assert result['representative_cases'] == 1
    assert result['representative_outcomes'] == {'passed': 1}


@pytest.mark.parametrize('field,value', [
    ('paths', ['tests/test_sample.py']), ('selection', 'ready'), ('keyword', 'core'),
    ('ignore', ['tests/test_other.py']), ('ignore_glob', ['tests/test_media*']),
])
def test_partial_scope_cannot_claim_full_coverage(evidence, field, value):
    evidence[0]['metadata'][field] = value
    with pytest.raises(ValueError, match='unfiltered'):
        audit_module.audit(*evidence)


def test_missing_representative_is_rejected(evidence):
    evidence[0]['tests'][0]['nodeid'] = 'tests/test_sample.py::test_other'
    with pytest.raises(ValueError, match='Missing PR representative'):
        audit_module.audit(*evidence)


def test_representative_cannot_be_moved_to_merge(evidence):
    evidence[0]['tests'][0].update(explicit_layers=['merge'], effective_layer='merge', migration_default=False)
    with pytest.raises(ValueError, match='moved out of ready'):
        audit_module.audit(*evidence)


def test_overlapping_layers_are_rejected(evidence):
    evidence[0]['tests'][0]['explicit_layers'] = ['ready', 'merge']
    with pytest.raises(ValueError, match='Conflicting'):
        audit_module.audit(*evidence)


def test_duplicate_ids_cannot_hide_a_missing_case(evidence):
    evidence[0]['tests'][1] = copy.deepcopy(evidence[0]['tests'][0])
    with pytest.raises(ValueError, match='Duplicate'):
        audit_module.audit(*evidence)


def test_incomplete_collection_is_rejected(evidence):
    evidence[0]['collection_complete'] = False
    with pytest.raises(ValueError, match='complete'):
        audit_module.audit(*evidence)


def test_missing_collected_case_is_rejected(evidence):
    evidence[0]['collected_count'] += 1
    with pytest.raises(ValueError, match='missing collected'):
        audit_module.audit(*evidence)


def test_deselection_cannot_hide_nonrepresentative_tests(evidence):
    evidence[0]['deselected_count'] = 1
    with pytest.raises(ValueError, match='unfiltered'):
        audit_module.audit(*evidence)


def test_export_cannot_be_removed_from_browser_gate(evidence):
    evidence[2]['scripts'][0]['lanes'] = ['extended']
    with pytest.raises(ValueError, match='browser gate'):
        audit_module.audit(*evidence)


def test_skipped_representative_is_not_execution_evidence(evidence):
    evidence[0]['tests'][0]['outcome'] = 'skipped'
    assert audit_module.audit(*evidence)['representative_outcomes'] == {'skipped': 1}
    with pytest.raises(ValueError, match='execution'):
        audit_module.audit(*evidence, require_executed=True)
