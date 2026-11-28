"""Generation receipt identity and execution state, independent of adoption."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from opendirector.domain.projects import ProjectError


FailureStage = Literal['prepare', 'submit', 'poll', 'download', 'check', 'save', 'adopt', 'cancel']


class ResultCheck(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['passed', 'failed'] = Field(description='Current operation lifecycle state.')
    facts: dict = Field(default_factory=dict, description='Observed technical validation facts.')
    message: str = Field(description='Human-readable issue description.')
    humanReviewRequired: bool = Field(default=True, description='Whether creative quality still requires human review.')


class GenerationFailure(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    category: Literal['input', 'reference', 'authentication', 'permission', 'quota', 'rate_limit',
                      'temporary', 'submission_unknown', 'local', 'protocol', 'provider'] = Field(description='Stable failure category.')
    stage: FailureStage = Field(description='Execution stage where the failure occurred.')
    message: str = Field(max_length=500, description='Human-readable issue description.')
    suggestion: str = Field(max_length=500, description='Suggested action to resolve the failure.')
    providerCode: str | None = Field(default=None, max_length=160, description='Provider error code.')
    requestId: str | None = Field(default=None, max_length=200, description='Provider request ID.')
    httpStatus: int | None = Field(default=None, ge=100, le=599, description='Provider HTTP response status.')
    providerStatus: Literal['failed', 'cancelled', 'expired'] | None = Field(default=None, description='Provider terminal task status.')


def vllm_remote_task_missing(protocol, external_id, details):
    """A known /videos task disappeared from its provider's status endpoint."""
    return bool(protocol == 'vllm_omni' and external_id and details.get('stage') == 'poll'
                and details.get('httpStatus') == 404 and details.get('category') == 'input')


class GenerationError(ProjectError):
    def __init__(self, details: GenerationFailure, status=502, message=None):
        super().__init__(message or f'{details.message} {details.suggestion} 不会自动重新提交。', status)
        self.details = details
