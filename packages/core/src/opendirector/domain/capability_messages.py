"""Translations for concrete capability failures, preserving their input detail."""
import re


_MESSAGES = {
    '服务已暂停，请恢复后重试。': 'Service paused. Resume it and try again.',
    '请补充所需素材。': 'Add the required inputs.',
    '图片文件过大，请压缩后重试。': 'The image is too large. Compress it and try again.',
    '图片总大小超出限制，请减少图片或压缩后重试。': 'The images exceed the total size limit. Remove or compress images.',
    '标注参考图片需要配合选区使用。': 'Add a selection to use the annotation reference.',
    '当前图片尺寸或数量不支持选区输入。': 'The image dimensions or count do not support selection input.',
    '选区与图片的尺寸不一致。': 'The selection and image dimensions must match.',
    '请先选择需要修改的区域。': 'Select the area to edit.',
    '无法读取图片或选区，请重新选择。': 'Cannot read the image or selection. Select it again.',
    '来源素材必须是图片。': 'Source assets must be images.',
}
_OPERATIONS = {'文字回复': 'text replies', '图片回复': 'image replies', '图片生成': 'image generation',
    '图片编辑': 'image editing', '文字生成视频': 'text-to-video generation', '图片生成视频': 'image-to-video generation',
    '视频编辑': 'video editing', '语音合成': 'speech synthesis', '音乐生成': 'music generation', '此操作': 'this operation'}
_INPUTS = {'图片': 'images', '音频': 'audio', '视频': 'video', '文字': 'text', '音色': 'a voice',
    '参考音频': 'reference audio', '风格说明': 'a style description', '参考文本': 'a reference transcript',
    '选区': 'a selection', '标注参考图片': 'an annotation reference', '素材': 'inputs'}
_PARAMETERS = {'图片尺寸': 'Image size', '图片宽度': 'Image width', '图片高度': 'Image height', '时长': 'Duration', '音色': 'Voice',
    '语速': 'Speech speed', '语言': 'Language', '帧率': 'Frame rate', '帧数': 'Frame count',
    '音频生成选项': 'Audio generation setting', '所选参数': 'The selected parameter'}
for _label, _english in _OPERATIONS.items():
    _MESSAGES[f'该模型不支持{_label}。'] = f'This model does not support {_english}.'
    _MESSAGES[f'服务未开放{_label}。'] = f'The service has not enabled {_english}.'
for _label, _english in _INPUTS.items():
    _MESSAGES[f'该模型不支持{_label}输入。'] = f'This model does not accept {_english}.'
    _MESSAGES[f'请添加{_label}。'] = f'Add {_english}.'
for _label, _english in _PARAMETERS.items():
    _MESSAGES[f'{_label}不符合服务要求。'] = f'{_english} does not meet the service requirements.'
_MESSAGES['图片尺寸不符合服务要求。'] = 'Image dimensions do not meet the service requirements.'


def constraint_rejection(reason, details):
    """The same specific diagnostic for admission and frozen execution checks."""
    code = 'capability_unavailable'
    roles = {'image': '图片', 'audio': '音频', 'video': '视频', 'text': '文字',
             'voice': '音色', 'reference_audio': '参考音频', 'instructions': '风格说明',
             'reference_text': '参考文本', 'mask_image': '选区', 'reference_image': '标注参考图片'}
    name = roles.get(details.get('input'), '素材')
    if reason == 'input_count_exceeded':
        if details['input'] == 'image':
            return 'image_input_count', f"最多支持 {details['maximum']} 张图片，当前为 {details['actual']} 张。"
        message = f"最多支持 {details['maximum']} 个{name}输入，当前为 {details['actual']} 个。"
    elif reason == 'input_unsupported':
        message = f'该模型不支持{name}输入。'
    elif reason == 'required_inputs_missing':
        if 'inputs' in details:
            choices = '或'.join(roles.get(role, '素材') for role in details['inputs'])
            message = f'请提供{choices}。'
        else:
            message = f'请添加{name}。'
    else:
        parameter = {'size': '图片尺寸', 'width': '图片宽度', 'height': '图片高度', 'duration': '时长', 'seconds': '时长',
                     'voice': '音色', 'speed': '语速', 'language': '语言', 'fps': '帧率',
                     'num_frames': '帧数', 'generate_audio': '音频生成选项'}.get(details.get('parameter'), '所选参数')
        message = f'{parameter}不符合服务要求。'
    return code, message


def english_capability_message(message):
    if message in _MESSAGES:
        return _MESSAGES[message]
    count = re.fullmatch(r'最多支持 (\d+) 张图片，当前为 (\d+) 张。', message)
    if count:
        return f'Up to {count[1]} images; {count[2]} added.'
    count = re.fullmatch(r'该工具需要 (\d+) 张来源图片。', message)
    if count:
        return f'This tool requires {count[1]} source images.'
    count = re.fullmatch(r'最多支持 (\d+) 个(.+)输入，当前为 (\d+) 个。', message)
    if count and count[2] in _INPUTS:
        return f'Up to {count[1]} {_INPUTS[count[2]]} inputs; {count[3]} added.'
    if message.startswith('请提供') and message.endswith('。'):
        roles = message[3:-1].split('或')
        if all(role in _INPUTS for role in roles):
            return 'Provide ' + ' or '.join(_INPUTS[role] for role in roles) + '.'
    return None
