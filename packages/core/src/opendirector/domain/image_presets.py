"""Shared image preset instructions for tools and generation jobs."""
from dataclasses import dataclass


@dataclass(frozen=True)
class ImagePreset:
    title: str
    prompts: tuple[str, ...]
    text_prompts: tuple[str, ...]
    size: tuple[int, int] = (2048, 1152)


THREE_VIEW_LAYOUT = (
    '横版画面分为三个等宽区域，从左至右严格排列：正面全身、右侧90度全身、背面全身。'
    '三个视图保持同一身份、年龄、体型、头身比、发型、服装、配色、材质及配饰，衣服结构与细节相互对应。'
    '全部自然站立、双臂放松，同一高度与地面基线，完整呈现头顶到鞋底，不裁头、不切脚、不遮挡、不重叠。'
)
THREE_VIEW_FINISH = (
    '纯净浅灰背景、均匀柔光、弱透视，无剧情场景、文字、标签、水印、分割线或额外视图。'
)
FOUR_VIEW_LAYOUT = (
    '从左到右依次为正面全身、右侧90度全身、背面全身、正脸特写，四个视图并排分开。'
    '前三格自然站立，头顶到鞋底完整，同一比例与地面基线；最右格只展示正面头肩，清楚呈现正脸。'
    '各视图保持同一人物、发型、服装和配饰。'
)
FOUR_VIEW_FINISH = '浅灰背景、均匀柔光，无文字、分割线、水印或额外视图。'
FOUR_VIEW_TEXT_SUBJECT = (
    '按提供的文字描述确定人物的外貌、服装与画风。未描述的细节自行设计，并在四个视图保持一致。'
)
FOUR_VIEW_TEXT = (
    '生成一张同一人物的横版四视图设定板。' + FOUR_VIEW_TEXT_SUBJECT
    + FOUR_VIEW_LAYOUT + FOUR_VIEW_FINISH
)
FACE_THREE_VIEW_LAYOUT = (
    '3:1超宽横版画面均分为三个等宽区域，从左至右严格排列：正面、左侧90度、右侧90度。'
    '第二格（左侧90度）鼻尖朝向画面右方，第三格（右侧90度）鼻尖朝向画面左方；'
    '两张侧脸朝向相反、左右镜像对称，不要输出两张朝向相同的侧脸。'
    '每个区域只放一个居中的头肩像，三个头像之间留有自然间隔，不接触、不重叠、不粘连。'
    '每个视图只呈现完整头部至肩颈，头顶、下巴、耳朵均完整，不出现背面或全身视图。'
    '保持同一身份、年龄、脸型、骨相、五官比例、肤色、发际线、发型及识别性细节，左右侧面符合真实结构。'
    '三个头部大小一致、眼睛基线对齐、中性表情、视线随朝向自然变化，面部不被头发遮挡。'
)
FACE_THREE_VIEW_FINISH = '纯净浅灰背景、均匀柔光，无美颜改脸、夸张透视、文字、标签、水印或额外人物。'
PRODUCT_THREE_VIEW_LAYOUT = (
    '横版画面分为三个等宽区域，从左至右严格排列：正视图、右侧90度侧视图、后视图。'
    '采用近正交投影、无广角畸变，同一比例尺、同一高度与底部基线，完整展示产品外轮廓，不裁切、不重叠。'
    '三个视图保持结构、尺寸关系、材质、颜色、表面纹理、接口、按钮、接缝及标识一致，细节在视角之间符合物理对应关系。'
)
PRODUCT_THREE_VIEW_FINISH = (
    '产品独立展示，纯白背景、均匀棚拍光，无人物、手、包装道具、剧情场景、说明文字、尺寸标注、水印或额外视图'
)
STORYBOARD_SHOTS = (
    '远景建立镜头，完整交代环境，主体在画面中较小。',
    '中景呈现同一主体的动作，主体占画面约一半高度。',
    '近景推到主体胸口以上，突出表情或主体的主要特征。',
    '特写呈现面部或关键细节，背景虚化。',
)
MULTI_CAMERA_ANGLES = (
    '主体正前方，平视拍摄。',
    '主体左前方约45度，从左侧斜角拍摄。',
    '主体右前方约45度，从右侧斜角拍摄。',
    '主体上方，高角度俯拍。',
)


PRESETS = {
    'three-view': ImagePreset('人物三视图', (
        '以参考图中的人物为唯一身份依据，生成同一人物的全身三视图设定板。'
        + THREE_VIEW_LAYOUT
        + '若原图仅有半身，依据可见服装合理补全下半身，补全部分在三个视角保持一致。保持参考图画风，'
        + THREE_VIEW_FINISH,
    ), (
        '按文字描述设计同一人物的全身三视图，未描述的外貌、服装或画风自行设计并保持一致。'
        + THREE_VIEW_LAYOUT + THREE_VIEW_FINISH,
    )),
    'four-view': ImagePreset('人物四视图', (
        '根据参考图生成一张同一人物的横版四视图设定板。'
        + FOUR_VIEW_LAYOUT
        + '若参考图只展示半身，合理补全下半身并保持一致。保持参考图画风、'
        + FOUR_VIEW_FINISH,
    ), (FOUR_VIEW_TEXT,), (3456, 1152)),
    'face-three-view': ImagePreset('面部三视图', (
        '以参考图人物的面部为唯一身份依据，生成同一人物的面部三视图参考板。'
        + FACE_THREE_VIEW_LAYOUT + '保持参考图画风、' + FACE_THREE_VIEW_FINISH,
    ), (
        '按文字描述设计同一个人的面部三视图，未描述的五官、发型与画风自行设计并保持一致。'
        + FACE_THREE_VIEW_LAYOUT + FACE_THREE_VIEW_FINISH,
    ), (3456, 1152)),
    'product-three-view': ImagePreset('产品三视图', (
        '以参考图中的产品为唯一设计依据，生成同一产品的工业设计三视图参考板。'
        + PRODUCT_THREE_VIEW_LAYOUT
        + '不可见部位依据已知结构作合理且一致的补全，不增加功能件或改变产品设计。'
        + PRODUCT_THREE_VIEW_FINISH + '；保留原有品牌标识。',
    ), (
        '按文字描述设计同一产品的工业设计三视图。未描述的结构、配色与材质按用途合理设计，不虚构品牌标识。'
        + PRODUCT_THREE_VIEW_LAYOUT + PRODUCT_THREE_VIEW_FINISH + '。',
    )),
    'storyboard': ImagePreset('连续分镜图',
        tuple('保持参考图的主体、环境和画风。' + shot for shot in STORYBOARD_SHOTS),
        tuple('按文字描述建立同一场景与主体，未描述处自行设计，四个镜头保持人物、服装、环境与光线连续。' + shot
              for shot in STORYBOARD_SHOTS)),
    'multi-camera': ImagePreset('多机位',
        tuple('保持参考图的主体、环境和光线，按指定机位调整透视和遮挡。' + angle for angle in MULTI_CAMERA_ANGLES),
        tuple('按文字描述设计主体和场景，未描述处自行补全。各机位保持主体、动作、空间布局和光线一致。' + angle
              for angle in MULTI_CAMERA_ANGLES)),
}

FOUR_VIEW_FACE_LAYOUT = (
    '同一角色的四格横排设定板，每格独立取景。\n'
    '第1格：正面身体，肩颈交界至脚底。第2格：右侧90度身体，肩颈交界至脚底。'
    '这两格以身体与服装为主，双脚完整。'
    '正面和侧面都将眼睛、鼻子和嘴留在画外。\n'
    '第3格：从头顶到鞋底的背面全身，人物缩小到完整后脑勺和双脚都在格内，头顶上方留空。\n'
    '第4格：唯一可见五官的正脸头肩特写。\n'
    '四格保持同一角色的体型、配色和装束。'
)
FOUR_VIEW_FACE_EMPHASIS = (
    '保持上传参考图的原始成像方式与画风。'
    '四格认真还原原图的材质纹理、细节密度、轮廓边缘、光影与用色，不作风格转换。\n'
    + FOUR_VIEW_FACE_LAYOUT
    + '\n设定板只规定排版和取景。改变视角、取景范围与背景，人物始终保持参考图原有的视觉质感。\n'
    + '保持参考图原有造型和服装，不添加参考图中没有的衣物、鞋帽和配饰。'
    + '若参考图只展示半身，合理补全下半身并保持一致。'
    + FOUR_VIEW_FINISH
)
FOUR_VIEW_FACE_TEXT = (
    FOUR_VIEW_FACE_LAYOUT + FOUR_VIEW_TEXT_SUBJECT + FOUR_VIEW_FINISH
)


def preset_instructions(key: str, face_emphasis: bool, *, has_reference: bool = True) -> tuple[str, ...]:
    if key == 'four-view' and face_emphasis:
        return (FOUR_VIEW_FACE_EMPHASIS if has_reference else FOUR_VIEW_FACE_TEXT,)
    preset = PRESETS.get(key)
    if not preset:
        return ()
    return preset.prompts if has_reference else preset.text_prompts


def preset_prompt(key: str, face_emphasis: bool, reference_titles: tuple[str, ...]) -> str | None:
    prompts = preset_instructions(key, face_emphasis, has_reference=bool(reference_titles))
    if not prompts:
        return None
    lines = []
    if len(reference_titles) > 1:
        labels = '、'.join(f'参考{index}（{title}）' for index, title in enumerate(reference_titles, 1))
        lines.append(f'本次共 {len(reference_titles)} 张参考图：{labels}。请按编号区分主体、场景与其他参考，不要把不同参考的角色混用。')
    if len(prompts) > 1:
        lines.append('按以下顺序逐张生成：')
        lines.extend(f'{index}. {prompt}' for index, prompt in enumerate(prompts, 1))
    else:
        lines.append(prompts[0])
    return '\n'.join(lines)
