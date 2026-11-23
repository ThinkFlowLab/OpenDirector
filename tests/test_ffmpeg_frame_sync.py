"""Capability parsing for FFmpeg releases unavailable on the current host.

test_tool_tasks exercises actual frame-preserving depth preparation with the
installed FFmpeg; these fixtures cover both CLI help formats and old releases.
"""
import json
import subprocess

import pytest

from opendirector.domain.projects import ProjectError
from opendirector.media import processing


pytestmark = pytest.mark.cpu


@pytest.mark.parametrize(('help_text', 'expected'), [
    (b'-fps_mode[:<stream_spec>]  set framerate mode\n', '-fps_mode'),
    (b'-fps_mode[:stream_specifier] fps_mode set framerate mode\n-vsync sync_mode set video sync\n', '-fps_mode'),
    (b'-vsync sync_mode    set video sync method globally\n', '-vsync'),
])
def test_frame_sync_uses_supported_option_and_caches_success(monkeypatch, help_text, expected):
    calls = []
    def help_output(arguments, *, timeout):
        calls.append(arguments)
        assert timeout == 10
        return help_text
    processing._frame_sync_option.cache_clear()
    monkeypatch.setattr(processing, '_run', help_output)
    try:
        assert processing._frame_sync_option() == expected
        assert processing._frame_sync_option() == expected
        assert calls == [['ffmpeg', '-hide_banner', '-h', 'full']]
    finally:
        processing._frame_sync_option.cache_clear()


def test_missing_sync_capability_does_not_assume_legacy_support(monkeypatch):
    processing._frame_sync_option.cache_clear()
    monkeypatch.setattr(processing, '_run', lambda *args, **kwargs: b'-r rate set frame rate\n')
    try:
        with pytest.raises(ProjectError, match='不支持保留视频帧时序'):
            processing._frame_sync_option()
    finally:
        processing._frame_sync_option.cache_clear()


def test_picture_preserves_variable_frame_timestamps_with_real_ffmpeg(tmp_path):
    source, output = tmp_path / 'source.mp4', tmp_path / 'picture.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10:duration=1',
                    '-vf', "select='eq(n,0)+eq(n,1)+eq(n,4)+eq(n,8)'", processing._frame_sync_option(),
                    'passthrough', '-c:v', 'libx264', str(source)], check=True, capture_output=True)
    processing.picture(source, output, width=128, height=72)
    for path, size in ((source, (64, 36)), (output, (128, 72))):
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_frames', '-show_streams',
                                                  '-of', 'json', str(path)]))
        assert len(info['streams']) == 1
        stream = info['streams'][0]
        assert (stream['width'], stream['height']) == size
        times = [float(frame['best_effort_timestamp_time']) for frame in info['frames']]
        assert times == pytest.approx([0, 0.1, 0.4, 0.8], abs=0.0001)
