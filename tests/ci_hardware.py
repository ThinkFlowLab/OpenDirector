"""CPU migration default and independent, mutually exclusive hardware marks."""
import pytest

PLATFORMS = frozenset({'cpu', 'gpu', 'cuda', 'rocm', 'xpu', 'npu'})


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(items):
    for item in items:
        platforms = {mark.name for mark in item.iter_markers() if mark.name in PLATFORMS}
        if len(platforms) > 1:
            raise pytest.UsageError(
                'Conflicting hardware platforms / 机型标记冲突: '
                + item.nodeid + ': ' + ', '.join(sorted(platforms)))
        if not platforms:
            item._ci_hardware_default = True
            item.add_marker(pytest.mark.cpu)
