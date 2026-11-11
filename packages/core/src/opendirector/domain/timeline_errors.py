"""Stable timed-text diagnostics shared by business and presentation boundaries."""
from typing import Literal

from opendirector.domain.projects import ProjectError

TimelineIssueCode = Literal[
    'timeline_package_invalid',
    'timeline_package_too_large',
    'timeline_revision_missing',
    'timeline_import_missing',
    'timeline_import_conflict',
    'timeline_registration_rejected',
    'timeline_font_too_large',
    'timeline_font_unavailable',
    'timeline_font_unsupported',
    'timeline_font_invalid',
    'timeline_font_fingerprint',
    'timeline_font_coverage',
    'timeline_font_total_bytes',
    'timeline_font_unverified',
    'timeline_font_mime',
    'timeline_bundled_font_fingerprint',
    'timeline_bundled_font_unavailable',
]

# Display copy is selected by code; business identity never depends on wording.
TIMELINE_MESSAGES = {
    'timeline_package_invalid': ('可编辑时间线包无效或格式不受支持。', 'Invalid or unsupported editable timeline package.'),
    'timeline_package_too_large': ('可编辑时间线包不能超过 512 MiB。', 'Editable timeline packages must not exceed 512 MiB.'),
    'timeline_revision_missing': ('所选时间线版本不存在。', 'Timeline revision does not exist.'),
    'timeline_import_missing': ('该时间线包导入记录不存在。', 'Timeline package import does not exist.'),
    'timeline_import_conflict': ('该导入操作标识已用于不同输入，请保留原输入重试。', 'Import operation identity is already used by different input.'),
    'timeline_registration_rejected': ('时间线资源登记被拒绝，请查询导入记录。', 'Timeline resource registration was rejected.'),
    'timeline_font_too_large': ('字体文件不能超过 32 MiB。', 'Font files must not exceed 32 MiB.'),
    'timeline_font_unavailable': ('字体文件不可用，请恢复文件后重试。', 'Font file is unavailable.'),
    'timeline_font_unsupported': ('仅支持静态 TTF 和 OTF 字体，不支持字体集合或可变字体。', 'Only static TTF and OTF fonts are supported.'),
    'timeline_font_invalid': ('字体数据无效或不完整，请检查实际格式。', 'Font data is invalid or incomplete.'),
    'timeline_font_fingerprint': ('字体内容与登记指纹不一致，请恢复原文件。', 'Font content differs from its recorded fingerprint.'),
    'timeline_font_coverage': ('所选字体未覆盖全部文字字符。', 'The selected font does not cover all text characters.'),
    'timeline_font_total_bytes': ('时间线实际使用的字体总量不能超过 64 MiB。', 'Timeline fonts must not exceed 64 MiB in total.'),
    'timeline_font_unverified': ('时间线字体资源不是已验证的静态字体。', 'Timeline font resource is not a verified static font.'),
    'timeline_font_mime': ('时间线字体实际格式与登记类型不一致。', 'Timeline font format differs from its recorded MIME type.'),
    'timeline_bundled_font_fingerprint': ('内置字体指纹不一致，请重新安装应用。', 'Bundled font fingerprint mismatch.'),
    'timeline_bundled_font_unavailable': ('内置字体不可用，请重新安装应用。', 'Bundled font is unavailable.'),
}


def timeline_error_message(code: str, language: str | None) -> str | None:
    messages = TIMELINE_MESSAGES.get(code)
    if messages is None:
        return None
    english = (language or "").lower().startswith("en")
    return messages[1 if english else 0]


def timeline_error(code: TimelineIssueCode, status: int = 400) -> ProjectError:
    return ProjectError(TIMELINE_MESSAGES[code][0], status, code=code)
