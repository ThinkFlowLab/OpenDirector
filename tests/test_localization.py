from types import SimpleNamespace

from opendirector_api.localization import (
    localized_error,
    localized_error_for_language,
    wants_english,
)


def request(language: str):
    return SimpleNamespace(headers={"accept-language": language})


def test_accept_language_uses_the_primary_language() -> None:
    assert wants_english(request("zh-CN,zh;q=0.9")) is False
    assert wants_english(request("zh-Hant")) is False
    assert wants_english(request("en-US,en;q=0.9")) is True
    assert wants_english(request("ja-JP")) is True
    assert wants_english(request("")) is False


def test_matting_error_codes_remain_localized_when_backend_copy_changes() -> None:
    for code, expected in [
        ('tool_concept_translation', 'short English subject description'),
        ('tool_no_video_match', 'not found in the video'),
    ]:
        assert expected in localized_error(request('en-US'), chinese='更新后的中文', status=422, code=code)
        assert localized_error(request('zh-CN'), chinese='更新后的中文', status=422, code=code) == '更新后的中文'


def test_chinese_and_english_messages_do_not_mix() -> None:
    assert (
        localized_error(
            request("zh-CN"), chinese="项目存储正忙", status=409, code="storage_busy"
        )
        == "项目存储正忙"
    )
    assert (
        localized_error(
            request("en-US"), chinese="项目存储正忙", status=409, code="storage_busy"
        )
        == "Project storage is busy. Try again shortly."
    )


def test_specific_code_wins_and_generic_code_falls_back_to_status() -> None:
    assert localized_error(
        request("en-US"), chinese="中文", status=422, code="invalid_input"
    ).startswith("The request is invalid")
    assert (
        localized_error(
            request("en-US"), chinese="中文", status=502, code="operation_rejected"
        )
        == "The upstream service failed. Check its configuration and try again."
    )
    assert (
        localized_error(request("en-US"), chinese="中文", status=404, code="unknown")
        == "The requested item no longer exists."
    )


def test_size_and_timeout_statuses_are_more_specific_than_generic_codes() -> None:
    assert (
        localized_error(
            request("en-US"), chinese="中文", status=413, code="invalid_input"
        )
        == "The file or request is too large."
    )
    assert (
        localized_error(
            request("en-US"), chinese="中文", status=504, code="operation_rejected"
        )
        == "The upstream service timed out. Check the service and try again."
    )


def test_streaming_and_background_jobs_use_the_same_language_rule() -> None:
    assert (
        localized_error_for_language(
            "zh-CN", chinese="Agent 执行失败。", status=500
        )
        == "Agent 执行失败。"
    )
    assert (
        localized_error_for_language(
            "en-US", chinese="Agent 执行失败。", status=500
        )
        == "The local service hit an unexpected error. Check the terminal for details."
    )
    assert (
        localized_error_for_language(
            "en-US", chinese="引用素材不属于当前工程。", status=409,
            code="operation_rejected",
        )
        == "The item changed or is busy. Reload it and try again."
    )
