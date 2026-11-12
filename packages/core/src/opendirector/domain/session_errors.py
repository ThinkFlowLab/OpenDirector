"""Lease lifecycle diagnostics; ownership never depends on display copy."""
from opendirector.domain.projects import ProjectError

SESSION_MESSAGES = {
    'session_stale': ('当前页面的编辑会话已过期，请刷新页面。', 'This page has an outdated editing session. Reload the page.'),
    'session_not_open': ('编辑会话已关闭，请重新打开工程。', 'The editing session is closed. Open the project again.'),
    'session_generation_invalid': ('编辑会话代次无效，请刷新页面。', 'Invalid editing session generation. Reload the page.'),
}


def session_error(code):
    return ProjectError(SESSION_MESSAGES[code][0], 422 if code == 'session_generation_invalid' else 409, code=code)
