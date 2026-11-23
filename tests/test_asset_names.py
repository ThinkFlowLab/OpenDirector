import pytest

from opendirector.media.filenames import with_extension


pytestmark = pytest.mark.cpu


@pytest.mark.parametrize(('name', 'suffix', 'expected'), [
    ('原版', 'mp4', '原版.mp4'),
    ('原版.mp4', 'mp4', '原版.mp4'),
    ('原版.mp4.mp4', 'mp4', '原版.mp4'),
    ('女王.JPG.jpg', 'jpg', '女王.jpg'),
    ('notes.v1', 'md', 'notes.v1.md'),
    ('', 'png', '素材.png'),
])
def test_output_name_does_not_append_an_existing_extension(name, suffix, expected):
    assert with_extension(name, suffix) == expected
