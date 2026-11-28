import importlib.util
from types import SimpleNamespace
from uuid import uuid4

import pytest

from opendirector.application.replacement_prompt import verify_replacement_prompt
from opendirector.domain.creation.segment_run import SegmentRunGenerated
from opendirector.domain.creation.validation import ContractError
from opendirector.installation import builtin_skills


def test_replacement_prompt_checks_exact_text_for_publication():
    path = builtin_skills() / 'character-replacement/scripts/build_head_prompts.py'
    module_spec = importlib.util.spec_from_file_location('head_prompt_renderer', path)
    renderer = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(renderer)
    inputs = {
        'tracks': ['left performer', 'right performer'],
        'shotSubjects': [[1, 2], [2]],
        'sourceAudio': True,
        'eyewear': [False, True],
        'dialogueBinding': {'shot': 2, 'subject': 2},
    }
    item = SimpleNamespace(id=uuid4(), title='W1')
    entry = SegmentRunGenerated(
        kind='generated', sourceStart=0, sourceEnd=124, itemId=item.id,
        shot='opening', step={'kind': 'anchor'}, replacementPromptInputs=inputs,
    )
    prompt = renderer.build_prompt(inputs)
    portrait_only = renderer.build_prompt({**inputs, 'portraitAppearanceOnly': True})
    assert portrait_only.replace(
        ' Reference pictures supply only the assigned appearance. '
        'Keep the source background and framing throughout.', '', 1,
    ) == prompt
    assert portrait_only != prompt
    complete_hair = renderer.build_prompt({**inputs, 'completeHairReplacement': 2})
    assert complete_hair.replace(
        ' Match the complete hairstyle from <Picture 2>, including the hair behind the ears and at the nape.',
        '', 1,
    ) == prompt
    assert complete_hair != prompt
    outline = renderer.build_prompt({**inputs, 'targetHairOutline': 2})
    assert outline.replace(
        ' Give <Subject 2> the hair outline of <Picture 2> and leave the ears and neck exposed as in the portrait.',
        '', 1,
    ) == prompt
    with pytest.raises(ValueError, match='targetHairOutline'):
        renderer.build_prompt({**inputs, 'targetHairOutline': 2, 'completeHairReplacement': 2})
    with pytest.raises(ValueError, match='completeHairReplacement'):
        renderer.build_prompt({**inputs, 'completeHairReplacement': 3})
    detail = prompt.split('detailed_description:\n')[1].split('\n\n')[0]
    assert detail.splitlines() == [
        '[Shot 1] <Subject 1> -> <Picture 1>, <Subject 2> -> <Picture 2>.',
        '[Shot 2] <Subject 2> -> <Picture 2>.',
        'Preserve the original cut between these shots in <Video 1>.',
        'Shot 2 stays on <Subject 2>, the same source performer as in the opening shot.',
    ]
    sound = prompt.split('overall_soundscape:\n')[1].split('\n\n')[0]
    assert sound.endswith(
        'In Shot 2, keep the original dialogue and its matching mouth movements on <Subject 2>.'
    )
    for invalid in ({'shot': 2, 'subject': 1}, {'shot': 3, 'subject': 2}):
        with pytest.raises(ValueError, match='dialogueBinding'):
            renderer.build_prompt({**inputs, 'dialogueBinding': invalid})
    with pytest.raises(ValueError, match='dialogueBinding'):
        renderer.build_prompt({**inputs, 'sourceAudio': False})
    verify_replacement_prompt(entry, SimpleNamespace(prompt=prompt, promptContent=None), item)
    with pytest.raises(ContractError, match='W1'):
        verify_replacement_prompt(entry, SimpleNamespace(prompt=prompt + ' ', promptContent=None), item)
    with pytest.raises(ContractError, match='W1'):
        verify_replacement_prompt(entry, SimpleNamespace(prompt=prompt, promptContent=(
            SimpleNamespace(type='text', text=prompt + ' '),
        )), item)
    assert 'replacementPromptInputs' not in entry.model_copy(
        update={'replacementPromptInputs': None},
    ).model_dump(mode='json')
