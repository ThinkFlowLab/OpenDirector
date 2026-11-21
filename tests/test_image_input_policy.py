"""The provider receives every accepted image, with distinct mask roles."""
from io import BytesIO
from types import SimpleNamespace

from PIL import Image
import pytest

from opendirector.domain.image_inputs import image_input_policy, native_mask_applicable, validate_image_request
from opendirector.domain.projects import ProjectError


def png(mode='RGB', size=(64, 64), color=128):
    output = BytesIO()
    Image.new(mode, size, color).save(output, format='PNG')
    return output.getvalue()


def request(**values):
    return SimpleNamespace(image=png(), references=(), mask=None, reference=None, width=64, height=64, **values)


def policy(maximum=4):
    return {'version': 1, 'maxImages': maximum, 'imageBytes': 8 * 1024 * 1024,
            'requestBytes': 48 * 1024 * 1024, 'nativeMask': None}


def native_policy():
    return {**policy(), 'nativeMask': {'field': 'mask_image', 'referenceField': 'reference_image',
        'encoding': 'grayscale_white_edit', 'minImages': 1, 'maxImages': 1, 'maxReferenceImages': 1,
        'widthMultiple': 16, 'heightMultiple': 16, 'minWidth': 64, 'minHeight': 64,
        'maxPixels': 1048576, 'sameSize': True}}


def test_z_image_accepts_one_image_from_its_existing_edit_adapter():
    config = {'kind': 'image', 'modelId': 'Tongyi-MAI/Z-Image-Turbo', 'protocol': 'openai', 'url': 'http://models.test/v1'}
    assert image_input_policy(config)['maxImages'] == 1


@pytest.mark.parametrize('count', [0, 1, 4])
def test_every_accepted_image_is_counted(count):
    value = request()
    value.image = png() if count else None
    value.references = (png(),) * max(0, count - 1)
    validate_image_request(value, policy())


def test_overflow_is_rejected_without_truncating_inputs():
    value = request()
    value.references = (png(),) * 4
    with pytest.raises(ProjectError, match='最多支持 4 张图片，当前为 5 张'):
        validate_image_request(value, policy())
    assert len(value.references) == 4


def test_mask_and_independent_reference_are_not_ordinary_images():
    value = request()
    value.mask, value.reference = png('L'), png()
    validate_image_request(value, native_policy())
    value.references = (png(),)
    with pytest.raises(ProjectError):
        validate_image_request(value, native_policy())


@pytest.mark.parametrize('width,height', [(63, 64), (65, 64), (2048, 1024)])
def test_native_selection_never_changes_requested_dimensions(width, height):
    assert not native_mask_applicable(native_policy(), width, height)


def test_missing_geometry_does_not_enable_native_mask():
    value = native_policy()
    del value['nativeMask']['widthMultiple']
    assert not native_mask_applicable(value, 64, 64)


def test_native_selection_applies_enum_steps_and_both_count_bounds():
    value = native_policy()
    value['nativeMask'].update(widthValues=[1024], heightValues=[1024])
    assert not native_mask_applicable(value, 64, 64)
    assert native_mask_applicable(value, 1024, 1024)
    value['nativeMask']['widthStep'] = 3
    assert not native_mask_applicable(value, 1024, 1024)
    value['nativeMask']['widthStep'] = 16
    value['maxImages'] = 0
    assert not native_mask_applicable(value, 1024, 1024)


def test_actual_mask_and_source_geometry_are_checked():
    value = request()
    value.mask = png('L', (80, 64))
    with pytest.raises(ProjectError):
        validate_image_request(value, native_policy())


def test_mask_requires_normalized_grayscale_and_nonempty_selection():
    value = request()
    for invalid in (png('RGBA'), png('L', color=0)):
        value.mask = invalid
        with pytest.raises(ProjectError):
            validate_image_request(value, native_policy())


def test_bytes_include_mask_and_independent_reference():
    value = request()
    value.mask, value.reference = png('L'), png()
    limited = native_policy()
    limited['requestBytes'] = len(value.image) + len(value.mask)
    with pytest.raises(ProjectError):
        validate_image_request(value, limited)
