export const availability = {
  "availability.reason.query_timeout": "查询超时，继续使用现有校验。",
  "availability.reason.query_busy": "服务检查繁忙，请稍后刷新。",
  "availability.reason.query_failed": "能力查询未成功，继续使用现有校验。",

  "availability.title": "服务能力",
  "availability.check": "检查服务能力",
  "availability.checking": "正在检查服务能力…",
  "availability.autoCheck": "自动检查服务能力",
  "availability.autoHint":
    "打开相关界面或提交新任务时检查。检查失败时保留手动配置。",
  "availability.checkedAt": "最近检查：{time}",
  "availability.status.available": "已声明支持",
  "availability.status.unavailable": "当前不可使用",
  "availability.status.unknown": "尚未确认",
  "availability.reason.not_checked": "尚未检查，可继续使用已保存的配置。",
  "availability.reason.supported": "服务声明支持此请求。",
  "availability.reason.operation_unsupported":
    "模型不支持此操作，请选择适合的模型。",
  "availability.reason.profile_unsupported":
    "模型不支持这种输入方式或输出用途。",
  "availability.reason.operation_disabled": "服务部署未开放此操作。",
  "availability.reason.route_disabled": "当前适配器使用的接口已被禁用。",
  "availability.reason.output_unsupported": "模型未声明支持所需的输出类型。",
  "availability.reason.execution_paused": "服务执行已暂停，恢复服务后重试。",
  "availability.reason.observation_expired":
    "检查结果已过期，可刷新；提交时将重新检查。",
  "availability.reason.connection_failed": "无法连接服务，保留现有配置和校验。",
  "availability.reason.authentication_failed": "服务鉴权失败，请检查连接凭据。",
  "availability.reason.protocol_unavailable":
    "服务未提供可识别的能力接口，继续使用手动配置。",
  "availability.reason.invalid_response": "能力响应无效，继续使用现有校验。",
  "availability.reason.unsupported_version":
    "无法识别能力协议版本，继续使用现有校验。",
  "availability.reason.declaration_incomplete":
    "服务说明不足，继续使用现有校验。",
  "availability.reason.required_inputs_missing":
    "当前请求缺少模型要求的必要输入。",
  "availability.reason.input_contract_unknown":
    "服务要求的输入尚未被当前适配器识别，继续使用现有校验。",
  "availability.reason.model_not_declared":
    "服务未说明这个精确模型名称的能力。",
  "availability.reason.operation_not_declared": "服务未说明此操作的能力。",
  "availability.reason.profile_not_declared": "服务未说明这种输入方式。",
  "availability.reason.route_not_declared": "服务未说明当前适配器使用的接口。",
  "availability.reason.adapter_not_mapped": "此适配器继续使用已有参数规则。",
  "availability.reason.mixed_operations": "不同操作的状态如下。",
  "availability.profile.text_response": "文字响应",
  "availability.profile.image_response": "聊天图片响应",
  "availability.profile.text_to_image": "图片生成",
  "availability.profile.image_to_image": "图片编辑",
  "availability.profile.text_to_video": "文字生成视频",
  "availability.profile.image_to_video": "图片生成视频",
  "availability.profile.video_to_video": "视频变换",
  "availability.profile.text_to_speech": "语音朗读",
  "availability.profile.lyrics_to_music": "歌词与风格生成音乐",
  "availability.profile.text_to_audio": "通用音频生成",
  "availability.profile.other": "其他请求方式",
} as const;
