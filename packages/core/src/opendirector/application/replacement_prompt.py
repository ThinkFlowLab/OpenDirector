"""Verify the saved prompt against the installed character-replacement renderer."""

import json
import subprocess
import sys

from opendirector.domain.creation.validation import ContractError
from opendirector.installation import builtin_skills


def verify_replacement_prompt(entry, spec, item):
    inputs = entry.replacementPromptInputs
    if inputs is None:
        return

    renderer = builtin_skills() / 'character-replacement/scripts/build_head_prompts.py'
    try:
        result = subprocess.run(
            [sys.executable, '-X', 'utf8', str(renderer), '-'],
            input=json.dumps({'prompt': inputs}), capture_output=True, text=True,
            encoding='utf-8', check=True, timeout=10,
        )
        expected = json.loads(result.stdout)['prompt']
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise ContractError(
            'invalid_input', f'片段「{item.title}」的结构化换人提示词无法渲染。', item.id,
        ) from error

    actual = spec.prompt
    if spec.promptContent is not None:
        if any(part.type != 'text' for part in spec.promptContent):
            raise ContractError(
                'invalid_input', f'片段「{item.title}」须将素材绑定保存为独立引用。', item.id,
            )
        actual = ''.join(part.text for part in spec.promptContent)
    for text in (spec.prompt, actual):
        if text != expected:
            first_difference = next(
                (index for index, (saved, rendered) in enumerate(zip(text, expected)) if saved != rendered),
                min(len(text), len(expected)),
            )
            line = expected.count('\n', 0, first_difference) + 1
            raise ContractError(
                'invalid_input', f'片段「{item.title}」的提示词与内置模板不一致（第 {line} 行）。', item.id,
            )
