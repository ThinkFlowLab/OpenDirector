/* DSH loads client exports through its browser module loader. React comes from the host. */
window.__ModuleLoader__.load({
  id: '@opendirector/dsh-plugin',
  factory(require) {
    const { cloneElement, createElement: h, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = require('react')
    const namespace = 'opendirector'
    const en = {
      reloadData: 'Reload',
      chooseModel: 'Choose a model', needsModel: 'Select a model to continue', promptPlaceholder: 'Describe the subject, setting and light.',
      needsProject: 'Choose a project or create one.', needsName: 'Enter a project name.',
      needsPrompt: 'Write a description or pick an example.', needsVoice: 'Enter a voice ID.',
      fileSize: 'File {size}', requestedSize: 'Requested {size}',
      recentRestored: 'Using your recent settings.', forgetRecent: 'Forget recent settings', recentForgotten: 'Recent settings cleared.',
      versionLabel: 'V{number}', sourceVersionLabel: 'From {title} · V{number}',
      examples: 'Try an example', exampleChoose: 'Example', exampleApply: 'Use this description',
      exampleReplace: 'Replace current description', exampleHint: 'Fills the description only. Review your model and settings, then generate when ready.',
      exampleStudio: 'Studio by the window',
      exampleStudioPrompt: 'Warm sunlight streams through a large studio window onto a wooden desk. A blue ceramic mug sits beside a leafy green plant. Natural light, realistic photography, shallow depth of field.',
      exampleCharacter: 'A character for an action pack',
      exampleCharacterPrompt: 'A small friendly robot with a rounded cream body, teal eyes and a tiny orange scarf. Full body, front view, centered, plain light background, clean silhouette, soft 3D illustration.',
      exampleCover: 'Product cover',
      exampleCoverPrompt: 'A single handmade ceramic mug on a pale wooden surface, soft side lighting, uncluttered warm background, realistic product photography. Leave space above for a title; no text in the image.',
      exampleLamp: 'Add a desk lamp',
      exampleLampPrompt: 'Keep the original composition and objects. Add a brass desk lamp on the left side of the wooden desk. Match the existing perspective, light and shadows.',
      exampleEvening: 'Change the lighting',
      exampleEveningPrompt: 'Keep the same subject, layout and camera position. Change the light to a calm blue evening with a warm lamp nearby. Preserve the identity and details of the original subject.',
      exampleWave: 'A gentle greeting',
      exampleWavePrompt: 'The character gently waves one hand in greeting, then returns to the starting pose. Keep the same character, framing and background. Fixed camera, smooth restrained movement.',
      examplePush: 'Slow camera move',
      examplePushPrompt: 'The camera moves slowly toward the main subject. Soft natural light and a gentle background breeze. Keep the original layout, objects and visual style.',
      exampleContinue: 'Continue the moment',
      exampleContinuePrompt: 'Continue smoothly from the end of the previous shot. Keep the same subject, setting, camera direction and lighting. Let the action settle naturally.',
      exampleSpeech: 'A short introduction',
      exampleSpeechPrompt: 'A quiet corner, a warm cup, and a little room to create. Welcome to our studio.',
      exampleNarration: 'A character introduction',
      exampleNarrationPrompt: 'Meet our little robot. It likes to wave hello, think through new ideas, and take a well-earned rest.',
      actionExamples: 'Example actions', actionExamplesHint: 'Replaces the action list. Keeps the shared description, reference image and model.',
      actionExampleApply: 'Replace action list', actionExampleStarter: 'Desktop companion',
      actionExampleMood: 'Expressions', packHappy: 'Happy', packHappyPrompt: 'Show a happy expression with a small cheerful bounce, keep the same character and camera framing.',
      packSleep: 'Rest', packSleepPrompt: 'Close the eyes and rest calmly, keep the same character, pose scale and camera framing.',
      connection: 'Connection check', connectionHint: 'Check your OpenDirector service and available model connections.',
      connectionChecking: 'Checking connection…', connectionReady: 'Connected',
      connectionPartial: 'Some checks need attention', connectionFailed: 'Could not reach OpenDirector',
      connectionApi: 'OpenDirector API', connectionCanvas: 'OpenDirector canvas', connectionProjects: 'Saved projects',
      connectionModels: 'Model connections', connectionCount: '{count} available',
      connectionNoModels: 'Add a model in OpenDirector → Settings → Model connections, then check again.',
      connectionConfigured: 'Listed models are configured in OpenDirector. A generation is needed to test provider access and output.',
      connectionNetwork: 'Start OpenDirector and check the API address. localhost refers to the computer running DSH.',
      connectionTimeout: 'OpenDirector did not respond in time. Check that the service has finished starting.',
      connectionAccess: 'The service refused access. Check the OpenDirector address and its local access settings.',
      connectionAddress: 'The API was not found at this address. Check baseUrl in the plugin configuration.',
      connectionService: 'OpenDirector returned an error. Check the service, then try again.',
      connectionResponse: 'The service returned an unexpected response. Check the API address and OpenDirector version.',
      connectionHost: 'The DSH connection is unavailable. Reconnect DSH, then try again.',
      connectionSetup: 'Set baseUrl and canvasBaseUrl in this profile’s opendirector row. The README shows the configuration.',
      connectionImage: 'Image generation', connectionEdit: 'Image references', connectionVideo: 'Image to video',
      connectionContinue: 'Video continuation', connectionVoice: 'Voiceover', connectionCheck: 'Check again',
      connectionCopy: 'Copy diagnostics', connectionCopied: 'Diagnostics copied.', connectionCopyFailed: 'Copy failed. Select and copy the diagnostic text below.',
      connectionGuide: 'Setup guide', connectionOpen: 'Open OpenDirector', connectionPlugin: 'Manage plugin',
      connectionDiagnostic: 'Diagnostic text', connectionReadOnly: 'This check reads project and model counts. It does not generate media.',
      packRevise: 'Adjust action', packEditPrompt: 'Action description', packSaveGenerate: 'Generate with this description',
      packCancelEdit: 'Cancel changes', packRevised: 'Description saved. Review it, then generate a candidate when ready.',
      packActive: 'Wait for this action’s task to finish before changing its description.',

      actionPacks: 'Action packs', newActionPack: 'Make an action pack', packTitle: 'Pack name',
      packHint: 'Keep one reference image, make each action separately, then choose one version per action.',
      packEmpty: 'No action packs in this project yet. Start from a saved image.',
      packSource: 'Use as character reference', packShared: 'Shared description', packActionName: 'Action name',
      packDescription: 'Describe this action', packAdd: 'Add an action', packRemove: 'Remove action',
      packCreate: 'Create and generate {count} actions', packMissing: 'Generate {count} unstarted actions',
      packCount: '{selected}/{total} actions selected', packExport: 'Download action pack',
      packExportHint: 'Choose one result for every action to export named media files and manifest.json (up to 128 MB).',
      packInvalid: 'Give the pack a name and add 1–6 actions with unique names and descriptions.',
      packNotStarted: 'Not started', packContinue: 'Continue original submission',
      packReference: 'Character reference', packSelectSource: 'Choose a saved reference image',
      packIdle: 'Idle', packIdlePrompt: 'Stand naturally, relaxed posture, keep the same character and appearance.',
      packWave: 'Wave', packWavePrompt: 'Wave one hand in greeting, keep the same character and appearance.',
      packThink: 'Think', packThinkPrompt: 'Tilt the head thoughtfully, keep the same character and appearance.',
      packDefaultTitle: 'Character actions',
      images: 'Image results', videos: 'Video results', original: 'Original', sourceClip: 'Source clip',
      viewOriginal: 'View original image', fitImage: 'Fit to window', actualImageSize: 'Actual size',
      originalUnavailable: 'Could not load the original image.', duration: '{seconds} s',
      candidate: 'Candidate', unavailable: 'Could not load the preview.', retryMedia: 'Reload preview',
      canvas: 'Open canvas', edit: 'Edit', firstFrame: 'Animate', continue: 'Continue', adopt: 'Adopt', adopted: 'Result adopted',
      createHint: 'Create an image or voiceover, then choose the version you want to keep.',
      libraryHint: 'Find your work, compare versions and pick up where you left off.',
      generationSettings: 'Generation settings',
      moreCandidateCount: 'Additional candidates', groupStopped: 'The remaining planned candidates were not submitted.',
      candidateCount: 'Number of candidates', generateGroup: 'Generate {count} candidates',
      groupHint: 'Sends {count} separate generation tasks. Results stay as candidates.',
      groupSummary: '{done}/{total} ready · {failed} failed', groupTask: 'Candidate {number}',
      groupUnsubmitted: '{count} planned candidates have not been confirmed.',
      continueGroup: 'Continue the original group', groupCompare: 'Compare selected images',
      candidateCountInvalid: 'Choose between 1 and 4 candidates.',
      create: 'Create media', brief: 'Describe what to change', copyId: 'Copy result ID', copied: 'Result ID copied.',
      firstFrameSource: 'First frame', motion: 'Describe the motion', shot: 'Describe the next shot',
      videoDuration: 'Video duration', chooseDuration: 'Choose a duration', modelDuration: 'This model uses its default duration.',
      useDefaultDuration: 'Use model default',
      durationUnavailable: 'This model does not support the selected duration.',
      videoModeUnavailable: 'Choose a model that supports this video action.',
      videoSourceUnavailable: 'The source result is unavailable. Refresh the project and try again.',
      continuationHint: 'Use the same model connection that generated this clip. The new clip keeps its dimensions.',
      continuationUnavailable: 'Open the canvas for details. If the source cache has expired, generate the source clip again.',
      resume: 'Resume project', close: 'Close', chooseProject: 'Choose a project',
      projectsEmpty: 'No OpenDirector projects yet.', resultsEmpty: 'This project has no saved media results.',
      loading: 'Loading…', refresh: 'Refresh results', libraryError: 'Could not load OpenDirector. Try refreshing.',
      recent: 'Saved results', selected: 'Current result', adopting: 'Adopting…', checkAdoption: 'Check adoption',
      tasks: 'Tasks', tasksEmpty: 'No generation tasks match these filters.', viewTask: 'View progress',
      taskProgress: 'Task progress', backgroundHint: 'Closing this dialog does not cancel the job. Find it under Resume project → Tasks.',
      cancelled: 'Cancelled', interrupted: 'Interrupted',
      pendingSubmissions: 'Submissions to check', pendingHint: 'Check the original submission without generating again.',
      startSeparateCreation: 'Start a separate creation',
      hidePending: 'Hide reminder', hidePendingHint: 'Hiding a reminder does not cancel a submitted job.',
      pendingStorageUnavailable: 'Recovery is available on this page, but cannot be saved. Check before reloading.',
      pendingCheckFailed: 'Could not check this submission. Try again when OpenDirector is available.',
      pendingNotAccepted: 'The original submission was not accepted.', pendingConfirmed: 'The original operation was confirmed. Open the canvas to continue.',
      reuseSettings: 'Reuse settings', resetTemplate: 'Reset to this version', keepOriginalOutput: 'Keep original size',
      reuseHint: 'Uses this version’s saved settings in a new node. Review the candidate before adopting.',
      reuseReferences: 'References kept from this version', referenceMedia: 'Reference media',
      reuseUnavailable: 'Could not load the saved settings. Reload them, or check the model and references in OpenDirector.',
      draftRestored: 'Unsubmitted draft restored.', clearDraft: 'Clear draft',
      modelUnavailable: 'The saved model is unavailable. Choose another model.',
      projectUnavailable: 'The saved project is unavailable. Choose another project.',
      stopGeneration: 'Request stop', stoppingGeneration: 'Requesting stop…', checkStop: 'Check stop request',
      stopRequested: 'Stop requested.', stopUnknown: 'The stop request has not been confirmed. Check the same request.',
      stopFinished: 'The task has already finished.', stopFailed: 'Could not request a stop. Check progress before trying again.',
      stopChanged: 'The task changed. Check progress and try again.', localStopped: 'Local processing has stopped.',
      remoteStopUnconfirmed: 'Provider cancellation has not been confirmed. Check the original task with the provider.',
      remoteStopped: 'The provider confirmed cancellation.',

      adoptUnknown: 'Adoption has not been confirmed yet. Check its status.',
      adoptBusy: 'Save and close the open OpenDirector canvas, then try again.',
      adoptConflict: 'This result or canvas has changed. Refresh the project before trying again.',
      adoptFailed: 'Could not adopt this result. Check the project and try again.',
      audios: 'Audio results', speech: 'Voiceover', picture: 'Image', mediaType: 'Media type',
      newProject: 'New project', projectName: 'Project name', model: 'Model', local: 'Self-hosted', hosted: 'Hosted',
      output: 'Image size', voice: 'Voice ID', prompt: 'Describe the image', speechText: 'Text to read aloud',
      chooseOutput: 'Choose an image size', useModelDefault: 'Use model default',
      outputUnavailable: '{size} is unavailable on this model. Choose a different size or model.',
      generate: 'Generate one candidate', submitting: 'Submitting…', checkGeneration: 'Check submission',
      repeatGeneration: 'Generate another candidate',
      repeatHint: 'Uses the settings saved on this canvas node. Existing candidates stay available.',
      repeatUnavailable: 'The generation node is unavailable. Open the canvas to check it.',
      noModels: 'Configure a compatible model in OpenDirector first.',
      failedToSubmit: 'Could not submit generation. Check your project and model settings.',
      generationUnknown: 'Submission has not been confirmed. Check it here or under Resume project → Submissions to check.',
      retrySubmission: 'Try submitting again', retryGeneration: 'Retry generation',
      connectionUnavailable: 'Could not reach OpenDirector. Reconnect, then try submitting again.',
      progressUnavailable: 'Could not check progress. Once connected, check the same job again.',
      providerUnknown: 'The model service may have received the request. Check the original job with the provider first.',
      rateLimited: 'The model service is rate limiting requests. Wait a moment before trying again.',
      credentialsRejected: 'The model service rejected the credentials. Check the API key in Model connections.',
      permissionDenied: 'The model service denied access. Check that the account can use this model.',
      inputRejected: 'The model service rejected the inputs. Open the canvas to review the settings or reference media.',
      recoverOnCanvas: 'Open the canvas to recover the existing job.',
      draftSaved: 'The generation settings are saved on the canvas.',
      waiting: 'Waiting for OpenDirector…', queued: 'Queued', running: 'Generating…',
      succeeded: 'Candidate ready', stopped: 'Generation stopped', failed: 'Generation failed',
      quota: 'Check the model account’s balance or quota before trying again.',
      checkProgress: 'Check progress', download: 'Download original',
      compareImages: 'Compare images', compareHint: 'Choose two images, then open the comparison.',
      openComparison: 'Open comparison', clearComparison: 'Clear comparison',
      chooseComparison: 'Compare this image', removeComparison: 'Remove from comparison',
      comparisonUnavailable: 'Could not load this comparison. Refresh the results and select two saved images.',
      buffering: 'Buffering…', updatesPaused: 'Automatic status checks are paused while offline or in the background.',
      searchLibrary: 'Search saved work', searchHint: 'Description, node name, model or ID',
      clearFilters: 'Clear search and filters', taskStatus: 'Filter tasks by status', allTasks: 'All tasks',
      activeTasks: 'Queued or running',
      libraryType: 'Filter by media', librarySelection: 'Filter by selection', libraryOrder: 'Sort results',
      allMedia: 'All media', video: 'Video', audio: 'Audio', allSelections: 'All results', other: 'Other results',
      previousPage: 'Previous page', nextPage: 'Next page', pageNumber: 'Page {number}',
      newest: 'Newest first', oldest: 'Oldest first', noMatches: 'No results match these filters.',
      actions: 'More actions', play: 'Play', pause: 'Pause', playbackFailed: 'Could not start playback.',
      references: 'Reference images', chooseReferences: 'Add reference images', hideReferences: 'Hide image picker',
      addReference: 'Add reference', removeReference: 'Remove reference', referenceImage: 'Reference image',
      moveReferenceEarlier: 'Move reference {number} earlier', moveReferenceLater: 'Move reference {number} later',
      noMoreImages: 'No other saved images on this page.',
      referenceOrder: 'The source stays first. Other images are sent in the order shown.',
      referenceLimit: 'This model accepts up to {count} reference images.',
      referencesChanged: 'Check the selected images and the model’s reference limit, then try again.',
    }
    const zh = {
      chooseModel: '请选择模型', needsModel: '先选择模型', promptPlaceholder: '想画什么？试着描述主体、场景和光线。',
      needsProject: '选择一个工程，或新建工程。', needsName: '请填写工程名称。',
      needsPrompt: '写一句描述，或选择一个示例。', needsVoice: '请填写音色 ID。',
      fileSize: '文件 {size}', requestedSize: '请求 {size}',
      reloadData: '重新读取',
      recentRestored: '已沿用上次设置。', forgetRecent: '清除最近设置', recentForgotten: '最近设置已清除。',
      versionLabel: 'V{number}', sourceVersionLabel: '来源：{title} · V{number}',
      examples: '试一个例子', exampleChoose: '创作示例', exampleApply: '填入这份描述',
      exampleReplace: '替换当前描述', exampleHint: '只填入描述。确认模型和参数后，再点击生成。',
      exampleStudio: '窗边工作室',
      exampleStudioPrompt: '阳光透过工作室的大窗洒在木桌上，桌上有一只蓝色陶瓷杯，旁边是一盆绿植。暖色自然光，真实摄影质感，浅景深。',
      exampleCharacter: '动作包的角色原图',
      exampleCharacterPrompt: '一个友好的小机器人，圆润的奶油色身体，青绿色眼睛，系着一条小橙色围巾。全身正面，居中，浅色纯背景，轮廓清晰，柔和的三维插画风格。',
      exampleCover: '产品封面',
      exampleCoverPrompt: '一只手工陶瓷杯放在浅色木桌上，柔和的侧光，温暖简洁的背景，真实产品摄影。画面上方留出标题空间，图片中不要出现文字。',
      exampleLamp: '加一盏台灯',
      exampleLampPrompt: '保留原来的构图和物体，在木桌左侧加一盏黄铜台灯。让透视、光线和阴影与原图一致。',
      exampleEvening: '换成傍晚光线',
      exampleEveningPrompt: '保留原图的主体、布局和机位，改为安静的蓝调傍晚光线，旁边有一盏暖色灯。保持主体身份和细节。',
      exampleWave: '角色挥手',
      exampleWavePrompt: '角色轻轻挥手打招呼，然后回到起始姿势。保持同一个角色、构图和背景，固定镜头，动作平滑自然。',
      examplePush: '缓慢推进',
      examplePushPrompt: '镜头缓缓向主体推进，自然光柔和，背景有轻微的风。保留原有布局、物体和视觉风格。',
      exampleContinue: '延续这个瞬间',
      exampleContinuePrompt: '从上一段结尾平滑接续，保持同一个主体、场景、镜头方向和光线，让动作自然收束。',
      exampleSpeech: '工作室开场白',
      exampleSpeechPrompt: '一处安静的角落，一杯热饮，一点创作的空间。欢迎来到我们的工作室。',
      exampleNarration: '角色介绍',
      exampleNarrationPrompt: '这是我们的小机器人。它喜欢挥手打招呼，认真思考新点子，也会在忙完以后好好休息。',
      actionExamples: '试用示例动作', actionExamplesHint: '替换动作列表，保留共用描述、参考图和模型。',
      actionExampleApply: '替换动作列表', actionExampleStarter: '桌宠基础动作',
      actionExampleMood: '表情动作', packHappy: '开心', packHappyPrompt: '露出开心的表情，轻轻跳一下，保持同一个角色和镜头构图。',
      packSleep: '休息', packSleepPrompt: '闭眼安静休息，保持同一个角色、身体比例和镜头构图。',
      connection: '连接检查', connectionHint: '查看 OpenDirector 服务和可用的模型连接。',
      connectionChecking: '正在检查连接…', connectionReady: '连接正常',
      connectionPartial: '部分检查需要处理', connectionFailed: '未能连接 OpenDirector',
      connectionApi: 'OpenDirector 接口', connectionCanvas: 'OpenDirector 画布', connectionProjects: '已保存工程',
      connectionModels: '模型连接', connectionCount: '{count} 个可用',
      connectionNoModels: '请在 OpenDirector → 设置 → 模型连接中添加模型，再检查一次。',
      connectionConfigured: '这里列出 OpenDirector 已配置的模型。服务商权限和生成效果需要实际生成后确认。',
      connectionNetwork: '请启动 OpenDirector，并检查接口地址。localhost 指的是运行 DSH 的那台电脑。',
      connectionTimeout: 'OpenDirector 未及时响应，请确认服务已经启动完成。',
      connectionAccess: '服务拒绝了访问，请检查 OpenDirector 地址和本地访问设置。',
      connectionAddress: '这个地址没有找到接口，请检查插件配置中的 baseUrl。',
      connectionService: 'OpenDirector 返回了错误，请检查服务后重试。',
      connectionResponse: '服务返回的内容不符合预期，请检查接口地址和 OpenDirector 版本。',
      connectionHost: 'DSH 连接暂时不可用，请重新连接 DSH 后重试。',
      connectionSetup: '在当前配置的 opendirector 行中设置 baseUrl 和 canvasBaseUrl，README 中有配置示例。',
      connectionImage: '生成图片', connectionEdit: '图片参考', connectionVideo: '图片转视频',
      connectionContinue: '视频续写', connectionVoice: '配音', connectionCheck: '重新检查',
      connectionCopy: '复制诊断信息', connectionCopied: '诊断信息已复制。', connectionCopyFailed: '复制失败，请选中下方诊断文本手动复制。',
      connectionGuide: '安装配置说明', connectionOpen: '打开 OpenDirector', connectionPlugin: '管理插件',
      connectionDiagnostic: '诊断文本', connectionReadOnly: '检查只读取工程和模型数量，不生成素材。',
      packRevise: '调整动作', packEditPrompt: '动作描述', packSaveGenerate: '按这份描述生成',
      packCancelEdit: '取消修改', packRevised: '描述已保存。确认后可以再生成一版候选。',
      packActive: '请等待这个动作的任务结束，再修改描述。',

      actionPacks: '动作素材包', newActionPack: '制作动作素材包', packTitle: '素材包名称',
      packHint: '固定一张角色参考图，分别生成各个动作，再为每个动作选一版。',
      packEmpty: '这个工程还没有动作素材包，可以从已保存的图片开始。',
      packSource: '用作角色参考', packShared: '共用描述', packActionName: '动作名称',
      packDescription: '描述这个动作', packAdd: '添加动作', packRemove: '移除动作',
      packCreate: '创建并生成 {count} 个动作', packMissing: '生成 {count} 个未开始的动作',
      packCount: '已选择 {selected}/{total} 个动作', packExport: '下载动作素材包',
      packExportHint: '每个动作选一版后，可导出按动作命名的媒体文件和 manifest.json，合计最多 128 MB。',
      packInvalid: '请填写素材包名称，添加 1 至 6 个名称不重复、描述完整的动作。',
      packNotStarted: '未开始', packContinue: '继续原提交',
      packReference: '角色参考图', packSelectSource: '选择已保存的参考图',
      packIdle: '待机', packIdlePrompt: '自然站立，姿态放松，保持同一个角色和外观。',
      packWave: '挥手', packWavePrompt: '抬起一只手打招呼，保持同一个角色和外观。',
      packThink: '思考', packThinkPrompt: '歪头思考，保持同一个角色和外观。',
      packDefaultTitle: '角色动作',
      images: '图片结果', videos: '视频结果', original: '原图', sourceClip: '源片段',
      viewOriginal: '查看原图', fitImage: '适应窗口', actualImageSize: '实际大小',
      originalUnavailable: '暂时无法加载原图。', duration: '{seconds} 秒',
      candidate: '候选', unavailable: '暂时无法加载预览。', retryMedia: '重新加载预览',
      canvas: '打开画布', edit: '改图', firstFrame: '转成视频', continue: '续写', adopt: '采用', adopted: '已采用结果',
      createHint: '生成图片或配音，比较候选后再选用。',
      libraryHint: '找回作品、对比版本，继续上次的创作。',
      generationSettings: '生成设置',
      moreCandidateCount: '新增候选数量', groupStopped: '其余计划候选未提交。',
      candidateCount: '候选数量', generateGroup: '生成 {count} 个候选',
      groupHint: '会提交 {count} 个独立生成任务，结果先保留为候选。',
      groupSummary: '已完成 {done}/{total} · 失败 {failed}', groupTask: '候选 {number}',
      groupUnsubmitted: '还有 {count} 个计划候选尚未确认提交。',
      continueGroup: '继续提交原候选组', groupCompare: '对比所选图片',
      candidateCountInvalid: '请选择 1 至 4 个候选。',
      create: '创作素材', brief: '描述你想改什么', copyId: '复制结果 ID', copied: '已复制结果 ID。',
      firstFrameSource: '首帧', motion: '描述画面怎么动', shot: '描述接下来的镜头',
      videoDuration: '视频时长', chooseDuration: '选择时长', modelDuration: '此模型使用默认时长。',
      useDefaultDuration: '使用模型默认时长',
      durationUnavailable: '当前模型不支持所选时长。',
      videoModeUnavailable: '请选择支持此视频操作的模型。',
      videoSourceUnavailable: '暂时无法使用源素材，请刷新工程后重试。',
      continuationHint: '请选择生成原片段时用的模型连接。续写沿用原片段的尺寸。',
      continuationUnavailable: '可在画布查看详情。如果源片段的接续缓存已过期，请重新生成源片段。',
      resume: '继续工程', close: '关闭', chooseProject: '选择工程',
      projectsEmpty: '还没有 OpenDirector 工程。', resultsEmpty: '这个工程还没有保存素材结果。',
      loading: '加载中…', refresh: '刷新结果', libraryError: '暂时无法读取 OpenDirector，请刷新重试。',
      recent: '已保存的结果', selected: '当前结果', adopting: '正在采用…', checkAdoption: '查询采用状态',
      tasks: '任务', tasksEmpty: '没有符合筛选条件的生成任务。', viewTask: '查看进度',
      taskProgress: '任务进度', backgroundHint: '关闭弹窗不会取消任务，可从「继续工程 → 任务」找回。',
      cancelled: '已取消', interrupted: '已中断',
      pendingSubmissions: '待确认的提交', pendingHint: '查询原来的提交，不会重新生成。',
      startSeparateCreation: '开始另一项创作',
      hidePending: '隐藏提示', hidePendingHint: '隐藏提示不会取消已提交的任务。',
      pendingStorageUnavailable: '本页仍可恢复，但无法保存恢复入口。请先查询再刷新。',
      pendingCheckFailed: '暂时无法查询这次提交，请在 OpenDirector 恢复连接后重试。',
      pendingNotAccepted: '原提交未被接受。', pendingConfirmed: '原操作已确认，可打开画布继续。',
      reuseSettings: '复用设置', resetTemplate: '恢复这版设置', keepOriginalOutput: '沿用原尺寸',
      reuseHint: '沿用所选版本的设置，在同一工程的新节点中生成候选，审阅后再采用。',
      reuseReferences: '沿用这版的参考素材', referenceMedia: '参考素材',
      reuseUnavailable: '暂时无法读取已保存的设置。可以重新读取，或在 OpenDirector 中检查模型与参考素材。',
      draftRestored: '已恢复未提交的草稿。', clearDraft: '清空草稿',
      modelUnavailable: '草稿中的模型暂不可用，请重新选择。',
      projectUnavailable: '草稿中的工程暂不可用，请重新选择。',
      stopGeneration: '请求停止', stoppingGeneration: '正在请求停止…', checkStop: '查询停止请求',
      stopRequested: '已请求停止。', stopUnknown: '尚未确认停止请求，请查询原操作。',
      stopFinished: '任务已结束。', stopFailed: '暂时无法请求停止，请先查询任务进度。',
      stopChanged: '任务状态已变化，请查询进度后重试。', localStopped: '本地处理已停止。',
      remoteStopUnconfirmed: '服务商取消尚未确认，请到服务商核对原任务。',
      remoteStopped: '服务商已确认取消。',

      adoptUnknown: '尚未确认是否采用，请查询状态。',
      adoptBusy: '请保存并关闭已打开的 OpenDirector 画布，然后重试。',
      adoptConflict: '结果或画布状态已变，请刷新工程后再试。',
      adoptFailed: '暂时无法采用此结果，请检查工程后重试。',
      audios: '音频结果', speech: '配音', picture: '图片', mediaType: '素材类型',
      newProject: '新建工程', projectName: '工程名称', model: '模型', local: '自部署', hosted: '在线服务',
      output: '图片尺寸', voice: '音色 ID', prompt: '描述要生成的图片', speechText: '要朗读的文字',
      chooseOutput: '选择图片尺寸', useModelDefault: '使用模型默认尺寸',
      outputUnavailable: '当前模型不支持 {size}。请选择其他尺寸或切换模型。',
      generate: '生成一个候选', submitting: '正在提交…', checkGeneration: '查询提交状态',
      repeatGeneration: '再生成一个候选',
      repeatHint: '使用此画布节点上保存的设置，已有候选仍可选择。',
      repeatUnavailable: '暂时无法使用该生成节点，请打开画布查看。',
      noModels: '请先在 OpenDirector 配置支持此操作的模型。',
      failedToSubmit: '暂时无法提交生成，请检查工程和模型设置。',
      generationUnknown: '尚未确认提交结果，可在这里或「继续工程 → 待确认的提交」查询。',
      retrySubmission: '重新提交', retryGeneration: '重试生成',
      connectionUnavailable: '暂时连不上 OpenDirector。恢复连接后可以重新提交。',
      progressUnavailable: '暂时查不到进度。恢复连接后，可以继续查询原任务。',
      providerUnknown: '模型服务可能已经收到请求。请先到服务商处核对原任务。',
      rateLimited: '模型服务限制了请求频率，请稍等再试。',
      credentialsRejected: '模型服务拒绝了当前凭证。请在「模型接入」中检查密钥。',
      permissionDenied: '模型服务拒绝了访问。请检查当前账号是否有权使用此模型。',
      inputRejected: '模型服务拒绝了输入。请到画布检查生成设置或参考素材。',
      recoverOnCanvas: '可打开画布恢复原任务。',
      draftSaved: '本次生成配置已保存到画布。',
      waiting: '等待 OpenDirector…', queued: '排队中', running: '生成中…',
      succeeded: '候选已生成', stopped: '生成已停止', failed: '生成失败',
      quota: '请检查模型账号的余额或套餐额度，再重试生成。',
      checkProgress: '查询进度', download: '下载原文件',
      compareImages: '对比图片', compareHint: '选择两张图片，再打开对比。',
      openComparison: '打开对比', clearComparison: '清空对比选择',
      chooseComparison: '加入图片对比', removeComparison: '移出图片对比',
      comparisonUnavailable: '暂时无法加载对比，请刷新结果并重新选择两张已保存图片。',
      buffering: '缓冲中…', updatesPaused: '离线或切到后台时，自动状态查询已暂停。',
      searchLibrary: '搜索已有作品', searchHint: '描述、节点名称、模型或 ID',
      clearFilters: '清除搜索和筛选', taskStatus: '按任务状态筛选', allTasks: '全部任务',
      activeTasks: '排队或生成中',
      libraryType: '按素材类型筛选', librarySelection: '按采用状态筛选', libraryOrder: '排序',
      allMedia: '全部素材', video: '视频', audio: '音频', allSelections: '全部结果', other: '其他结果',
      previousPage: '上一页', nextPage: '下一页', pageNumber: '第 {number} 页',
      newest: '最新优先', oldest: '最早优先', noMatches: '没有符合筛选条件的结果。',
      actions: '更多操作', play: '播放', pause: '暂停', playbackFailed: '暂时无法播放。',
      references: '参考图', chooseReferences: '添加参考图', hideReferences: '收起选图',
      addReference: '加入参考图', removeReference: '移除参考图', referenceImage: '参考图',
      moveReferenceEarlier: '将参考图 {number} 前移', moveReferenceLater: '将参考图 {number} 后移',
      noMoreImages: '这一页没有其他已保存的图片。',
      referenceOrder: '原图固定在第一张，其他图片按显示顺序发送。',
      referenceLimit: '当前模型最多支持 {count} 张参考图。',
      referencesChanged: '请核对所选图片和模型的参考图上限，再试一次。',
    }

    const border = '1px solid var(--dsw-alias-border-l1)'
    const muted = 'var(--dsw-alias-label-secondary)'
    const surface = 'var(--dsw-alias-markdown-code-block)'
    const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.4rem' }
    const buttonStyle = {
      font: 'inherit', fontSize: '.82em', padding: '.3rem .65rem', borderRadius: '.45rem',
      border, cursor: 'pointer',
    }
    const dialogStyle = { width: 'min(52rem, calc(100vw - 2rem))', maxHeight: '86vh', boxSizing: 'border-box',
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border,
      borderRadius: '1rem', padding: '1.25rem', boxShadow: '0 18px 60px #0003' }
    const clientStyles = `
      .od-media-ui { color: var(--dsw-alias-label-primary); line-height: 1.5; }
      .od-media-ui::backdrop { background: rgb(0 0 0 / .42); }
      .od-media-ui .od-button { display: inline-flex; align-items: center; justify-content: center; gap: .35rem;
        min-height: 2.15rem; background: transparent; color: inherit; text-decoration: none; transition: background 120ms, border-color 120ms; }
      .od-media-ui .od-button:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
      .od-media-ui .od-button.od-primary { background: var(--dsw-alias-button-primary-fill);
        color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }
      .od-media-ui .od-button.od-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover); }
      .od-media-ui .od-button:disabled { opacity: .5; cursor: default; }
      .od-media-ui .od-button[data-current] { opacity: 1; color: var(--dsw-alias-brand-text);
        background: var(--dsw-alias-interactive-bg-active); border-color: transparent; }
      .od-media-ui :is(button, a, input, select, textarea, summary):focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
      .od-media-ui :is(select, textarea, input:not([type=checkbox])) { box-sizing: border-box; max-width: 100%;
        padding: .5rem .65rem; border: 1px solid var(--dsw-alias-border-l1); border-radius: .55rem;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; }
      .od-media-ui form :is(input:not([type=checkbox]), select, textarea) { width: 100%; }
      .od-media-ui form :is(input, select, textarea):disabled { opacity: .7; }
      .od-media-ui form label { font-size: .85em; }
      .od-media-ui .od-launcher { width: 2rem; min-height: 2rem; padding: 0 !important; border-color: transparent; }
      .od-create-form { display: grid; gap: .85rem; }
      .od-create-form > label:first-child { font-weight: 600; }
      .od-create-form > label:first-child textarea { resize: vertical; min-height: 5.75rem; font-weight: normal; }
      .od-create-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(19rem,100%),1fr)); gap: .8rem 1.2rem;
        border-top: 1px solid var(--dsw-alias-border-l1); padding-block: 1rem .5rem; align-items: start; }
      .od-submit-row { display: flex; flex-wrap: wrap; gap: .45rem .8rem; align-items: center;
        border-top: 1px solid var(--dsw-alias-border-l1); padding-top: .75rem; }
      .od-submit-row small { color: var(--dsw-alias-label-secondary); flex: 1; }
      .od-field-link { font: inherit; color: var(--dsw-alias-brand-text); cursor: pointer;
        background: transparent; border: 0; padding: .25rem 0; text-decoration: underline; text-underline-offset: .2em; }
      .od-media-ui [role=menuitem]:is(:hover,:focus-visible) { background: var(--dsw-alias-interactive-bg-hover); }
      .od-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
        margin-bottom: 1rem; padding-bottom: .9rem; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .od-dialog-header h2 { margin: .15rem 0; font-size: 1.15em; font-weight: 650; letter-spacing: -.02em; }
      .od-eyebrow { color: var(--dsw-alias-label-secondary); font-size: .72em; letter-spacing: .04em; }
      .od-hint { display: block; margin-top: .25rem; color: var(--dsw-alias-label-secondary); font-size: .8em; }
      .od-media-ui .od-preview { --od-preview-height: clamp(8rem, 23vw, 15rem); padding: .7rem; border: 1px solid var(--dsw-alias-border-l1); border-radius: .85rem;
        background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
      .od-media-ui .od-preview:only-child { --od-preview-height: clamp(14rem, 36vh, 23rem); }
      .od-media-ui .od-preview[data-selected] { border-color: var(--dsw-alias-brand-primary); }
      .od-version { font-size: .75em; padding: .05rem .45rem; border: 1px solid var(--dsw-alias-border-l1); border-radius: 1rem; }
      .od-version[data-current] { color: var(--dsw-alias-brand-text); border-color: var(--dsw-alias-brand-primary); }
      .od-preview figcaption { justify-content: space-between; padding: .1rem 0 .35rem; }
      .od-media-ui .od-settings { padding: .6rem .75rem; margin-block: .7rem;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: .65rem; }
      .od-settings > summary { color: var(--dsw-alias-label-secondary); font-size: .8em; cursor: pointer; }
      .od-media-ui [role=status] { font-size: .88em; }
      .od-media-ui [role=alert] { padding: .65rem .75rem; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: .6rem; font-size: .85em; }
      @media (prefers-reduced-motion: reduce) { .od-media-ui .od-button { transition: none; } }
      @media (max-width: 480px) {
        dialog.od-media-ui { padding: .85rem !important; }
        .od-media-ui .od-preview { padding: .55rem; }
      }
    `
    const libraryDefaults = { kind: 'all', selection: 'all', order: 'newest', status: 'all' }
    const submissionMessages = new Map([
      ['creation.candidate_count', 'candidateCountInvalid'],
      ['storage_busy', 'adoptBusy'], ['creation.unavailable', 'connectionUnavailable'],
      ['creation.repeat_unavailable', 'repeatUnavailable'], ['revision_conflict', 'adoptConflict'],
      ['creation.references', 'referencesChanged'], ['creation.reference_limit', 'referencesChanged'],
      ['result.candidate_missing', 'referencesChanged'],
      ['creation.video_mode', 'videoModeUnavailable'], ['creation.video_duration', 'durationUnavailable'],
      ['creation.video_source', 'videoSourceUnavailable'],
      ['creation.template_unavailable', 'reuseUnavailable'], ['creation.template_complex', 'reuseUnavailable'],
    ])
    const generationMessages = new Map([
      ['quota', 'quota'], ['rate_limit', 'rateLimited'], ['authentication', 'credentialsRejected'],
      ['permission', 'permissionDenied'], ['input', 'inputRejected'], ['reference', 'inputRejected'],
      ['submission_unknown', 'providerUnknown'],
    ])

    function icon(name) {
      const paths = {
        create: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z',
        library: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
        check: 'm5 12 4 4L19 6',
        connection: 'M8 3v4M16 3v4M6 7h12v3a6 6 0 0 1-12 0ZM12 16v5',
      }
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false, style: { flexShrink: 0 } }, h('path', { d: paths[name] }))
    }

    function button(label, onClick, options = {}) {
      const { primary, current, symbol, className, ...attrs } = options
      return h('button', {
        type: 'button', onClick, ...attrs,
        className: ['od-button', primary && 'od-primary', className].filter(Boolean).join(' '),
        'data-current': current || undefined,
        style: { ...buttonStyle, ...((primary || current) && { fontWeight: 600 }) },
      }, symbol && icon(symbol), label)
    }

    function dialogHeader(title, close, t, hint) {
      return h('header', { className: 'od-dialog-header' },
        h('div', null, h('span', { className: 'od-eyebrow' }, 'OpenDirector'),
          h('h2', null, title), hint && h('small', { className: 'od-hint' }, hint)),
        button(t('close'), close))
    }

    function SubmitRow({ reason, busy, label, focusModel }) {
      const hint = useId()
      return h('div', { className: 'od-submit-row' },
        h('small', { id: hint, role: 'status' }, focusModel
          ? h('button', { type: 'button', className: 'od-field-link', onClick: e => e.currentTarget.form.elements.namedItem('model').focus() }, reason)
          : reason),
        button(label, undefined, { type: 'submit', primary: true, disabled: busy || Boolean(reason),
          'aria-describedby': reason ? hint : undefined }))
    }

    function mediaHref(project, asset, kind) {
      return '/api/opendirector/media?' + new URLSearchParams({ project, asset, kind })
    }

    const recentKey = '@opendirector/dsh-plugin:recent:v1:'
    const recentCache = new Map()
    function readRecent(scope) {
      if (!scope) return {}
      if (!recentCache.has(scope)) {
        let value
        try { value = JSON.parse(window.localStorage.getItem(recentKey + scope) ?? '{}') } catch {}
        recentCache.set(scope, value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      }
      return recentCache.get(scope)
    }
    function rememberRecent(scope, changes) {
      if (!scope) return
      const previous = readRecent(scope)
      const value = { ...previous, ...changes,
        ...(changes.setups && { setups: { ...previous.setups, ...changes.setups } }) }
      recentCache.set(scope, value)
      try { window.localStorage.setItem(recentKey + scope, JSON.stringify(value)) } catch {}
    }
    function forgetRecent(scope) {
      recentCache.set(scope, {})
      try { window.localStorage.removeItem(recentKey + scope) } catch {}
    }
    function recentSetup(catalog, context, kind, videoMode) {
      const saved = readRecent(catalog?.scope).setups?.[context]
      const model = catalog?.models?.find(item => item.id === saved?.modelId && item.kind === kind
        && (videoMode ? item.videoChoices?.[videoMode] : context === 'edit' || context.startsWith('pack:') ? item.maxImages > 0 : true))
      if (!model) return {}
      const output = saved.output && typeof saved.output.size === 'string' && typeof saved.output.aspectRatio === 'string'
        ? { size: saved.output.size, aspectRatio: saved.output.aspectRatio } : null
      const durationSeconds = Number.isFinite(saved.durationSeconds) ? saved.durationSeconds : null
      return { modelId: model.id, output, durationSeconds }
    }

    const mediaDraftKey = '@opendirector/dsh-plugin:media-drafts:v1'
    let mediaDrafts = new Map()
    let draftsLoaded = false
    let draftTimer
    function readMediaDraft(key) {
      if (!draftsLoaded) {
        draftsLoaded = true
        try {
          const entries = JSON.parse(window.sessionStorage.getItem(mediaDraftKey) ?? '[]')
          if (Array.isArray(entries)) {
            mediaDrafts = new Map(entries.filter(entry => Array.isArray(entry) && entry.length === 2
              && typeof entry[0] === 'string' && entry[1]?.form && typeof entry[1].form.prompt === 'string'))
          }
        } catch {}
      }
      return mediaDrafts.get(key)
    }
    function flushMediaDrafts() {
      if (!draftsLoaded) return
      clearTimeout(draftTimer)
      try {
        if (mediaDrafts.size) window.sessionStorage.setItem(mediaDraftKey, JSON.stringify([...mediaDrafts]))
        else window.sessionStorage.removeItem(mediaDraftKey)
      } catch {}
    }
    function saveMediaDraft(key, value) {
      readMediaDraft(key)
      mediaDrafts.delete(key)
      if (value) mediaDrafts.set(key, value)
      clearTimeout(draftTimer)
      draftTimer = setTimeout(flushMediaDrafts, 250)
    }

    const pendingSubmissionsKey = '@opendirector/dsh-plugin:pending-submissions:v1'
    const pendingListeners = new Set()
    let pendingSubmissions
    let pendingDurable = true
    const pendingIdentity = item => item.projectId + ':' + item.operationId
    function readPendingSubmissions() {
      if (pendingSubmissions) return pendingSubmissions
      try {
        const values = JSON.parse(window.sessionStorage.getItem(pendingSubmissionsKey) ?? '[]')
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        const entries = Array.isArray(values) ? values.filter(item => item && uuid.test(item.projectId)
          && uuid.test(item.operationId) && typeof item.context === 'string' && item.context.length <= 160
          && (item.repeatJobId == null || uuid.test(item.repeatJobId))).map(item => ({
            projectId: item.projectId, operationId: item.operationId, context: item.context,
            label: typeof item.label === 'string' ? item.label.slice(0, 160) : '',
            ...(typeof item.projectName === 'string' && { projectName: item.projectName.slice(0, 255) }),
            ...(item.repeatJobId && { repeatJobId: item.repeatJobId }),
            ...(['prepare', 'generate', 'revise'].includes(item.packAction) && {
              packAction: item.packAction, packRedo: item.packRedo === true,
              ...(uuid.test(item.packId) && { packId: item.packId }),
              ...(Array.isArray(item.packItemIds) && item.packItemIds.length <= 6
                && item.packItemIds.every(id => uuid.test(id)) && { packItemIds: item.packItemIds }),
            }),
            ...(Number.isInteger(item.candidateCount) && item.candidateCount >= 2 && item.candidateCount <= 4
              && { candidateCount: item.candidateCount }),
          })) : []
        pendingSubmissions = [...new Map(entries.map(item => [pendingIdentity(item), item])).values()]
      } catch {
        pendingSubmissions = []
        pendingDurable = false
      }
      return pendingSubmissions
    }
    function subscribePending(listener) {
      pendingListeners.add(listener)
      return () => pendingListeners.delete(listener)
    }
    function writePendingSubmissions(items) {
      pendingSubmissions = items
      try {
        if (items.length) window.sessionStorage.setItem(pendingSubmissionsKey, JSON.stringify(items))
        else window.sessionStorage.removeItem(pendingSubmissionsKey)
        pendingDurable = true
      } catch { pendingDurable = false }
      for (const listener of pendingListeners) listener()
    }
    function rememberSubmission(input, context, label) {
      const item = {
        projectId: input.projectId, operationId: input.operationId, context, label: label.slice(0, 160),
        ...(input.projectName != null && { projectName: input.projectName.slice(0, 255) }),
        ...(input.repeatJobId && { repeatJobId: input.repeatJobId }),
        ...(input.packAction && { packAction: input.packAction, packId: input.packId,
          packItemIds: input.packItemIds, packRedo: input.packRedo === true }),
        ...(input.candidateCount > 1 && { candidateCount: input.candidateCount }),
      }
      writePendingSubmissions([...readPendingSubmissions().filter(value => pendingIdentity(value) !== pendingIdentity(item)), item])
    }
    function forgetSubmission(item) {
      if (!item) return
      const previous = readPendingSubmissions()
      const next = previous.filter(value => pendingIdentity(value) !== pendingIdentity(item))
      if (next.length !== previous.length) writePendingSubmissions(next)
    }

    function PendingSubmissions({ context, onRecovered, disabled = false, t }) {
      const saved = useSyncExternalStore(subscribePending, readPendingSubmissions)
      const items = context === 'packs' ? saved.filter(item => item.packAction) : context ? saved.filter(item => item.context === context) : saved
      const [page, setPage] = useState({})
      const [feedback, setFeedback] = useState({})
      const busy = useRef(new Set())
      const start = page.after ? items.findIndex(item => pendingIdentity(item) === page.after) + 1 : 0
      const visible = items.slice(start, start + 12)
      useEffect(() => {
        if (page.after && !items.some(item => pendingIdentity(item) === page.after)) setPage({})
      }, [saved, page, context])
      async function check(item) {
        const key = pendingIdentity(item)
        if (busy.current.has(key)) return
        busy.current.add(key)
        setFeedback(previous => ({ ...previous, [key]: { message: 'submitting' } }))
        try {
          const { projectId, operationId, repeatJobId, projectName, candidateCount } = item
          const response = await fetch(item.packAction ? '/api/opendirector/action-packs' : '/api/opendirector/creation', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenDirector-Action': '1' },
            body: JSON.stringify(item.packAction ? { action: 'check', projectId, operationId,
              packId: item.packId, packAction: item.packAction, itemIds: item.packItemIds } : { projectId, operationId, ...(repeatJobId && { repeatJobId }),
              ...(projectName != null && { projectName }), ...(candidateCount && { candidateCount }), check: true }),
          })
          if (!response.ok) throw new Error('Receipt unavailable')
          const value = await response.json()
          if (item.packAction && value.found) {
            setFeedback(previous => ({ ...previous, [key]: { message: value.status === 'unknown' ? 'generationUnknown' : 'pendingConfirmed' } }))
            onRecovered({ ...value, projectId, recovery: item })
          } else if (value.jobId && (value.groupId || ['accepted', 'applied', 'noop'].includes(value.status))) {
            onRecovered({ ...value, projectId, prompt: item.label, recovery: item,
              ...(value.groupId && { requestedCount: candidateCount }) })
          } else {
            setFeedback(previous => ({ ...previous, [key]: {
              message: value.status === 'unknown' ? 'generationUnknown'
                : value.status === 'rejected' ? 'pendingNotAccepted' : 'pendingConfirmed',
              canvasUrl: value.draftSaved || value.projectCreated ? value.canvasUrl : undefined,
            } }))
          }
        } catch {
          setFeedback(previous => ({ ...previous, [key]: { message: 'pendingCheckFailed' } }))
        } finally {
          busy.current.delete(key)
          setFeedback(previous => ({ ...previous, [key]: { ...previous[key] } }))
        }
      }
      if (!items.length) return null
      return h('section', { 'aria-label': t('pendingSubmissions'), style: { display: 'grid', gap: '.5rem', marginBlock: '.7rem' } },
        h('strong', null, t('pendingSubmissions')), h('small', null, t('pendingHint')),
        !pendingDurable && h('p', { role: 'alert' }, t('pendingStorageUnavailable')),
        ...visible.map(item => {
          const key = pendingIdentity(item)
          const value = feedback[key]
          return h('article', { key, style: { display: 'grid', gap: '.4rem', border, padding: '.6rem', borderRadius: '.55rem' } },
            h('span', { style: { overflowWrap: 'anywhere' } }, item.projectName || item.label || item.projectId),
            item.projectName && item.label && h('small', null, item.label),
            h('div', { style: row },
              button(t('checkGeneration'), () => check(item), { disabled: disabled || busy.current.has(key) }),
              button(t('hidePending'), () => forgetSubmission(item), { title: t('hidePendingHint'), disabled: disabled || busy.current.has(key) }),
              value?.canvasUrl && canvasLink(value.canvasUrl, t)),
            value?.message && h('small', { role: 'status' }, t(value.message)))
        }),
        h('small', null, t('hidePendingHint')),
        h(PageControls, { cursor: page,
          nextCursor: items.length > start + 12 ? pendingIdentity(visible.at(-1)) : null, onPage: setPage, t }))
    }

    function CreateMedia({ t, openPlugin }) {
      const [open, setOpen] = useState(null)
      const [menu, setMenu] = useState(null)
      const trigger = useRef(null)
      const actions = [['create', 'creation'], ['resume', 'library'], ['actionPacks', 'packs'], ['connection', 'connection']]
        .map(([label, page]) => ({ label, run: () => setOpen(page) }))
      return h('div', { className: 'od-media-ui', style: row },
        button(icon('create'), event => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu(menu ? null : { x: rect.left, y: rect.top, above: true })
        }, { ref: trigger, className: 'od-launcher', title: 'OpenDirector', 'aria-label': 'OpenDirector',
          'aria-haspopup': 'menu', 'aria-expanded': Boolean(menu) }),
        menu && h(ActionMenu, { actions, position: menu, trigger, t, label: 'OpenDirector',
          close: (restore = true) => { setMenu(null); if (restore) trigger.current?.focus() } }),
        open === 'connection' && h(ConnectionDialog, { t, openPlugin, onClose: () => setOpen(null) }),
        open === 'packs' && h(ActionPackLibrary, { t, onClose: () => setOpen(null) }),
        open === 'library' && h(ProjectLibrary, { t, onClose: () => setOpen(null) }),
        open === 'creation' && h(GenerationDialog, { t, onClose: () => setOpen(null) }))
    }

    function ConnectionDialog({ t, openPlugin, onClose }) {
      const dialog = useRef(null)
      const [value, setValue] = useState(null)
      const [failed, setFailed] = useState(false)
      const [checking, setChecking] = useState(true)
      const [revision, setRevision] = useState(0)
      const [copyState, setCopyState] = useState('')
      const [forgotten, setForgotten] = useState(false)
      useEffect(() => { dialog.current.showModal() }, [])
      useEffect(() => {
        const controller = new AbortController()
        setChecking(true)
        setValue(null)
        setFailed(false)
        setCopyState('')
        fetch('/api/opendirector/connection', { signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error('Connection check unavailable')
          const report = await response.json()
          if (!controller.signal.aborted) setValue(report)
        }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
          .finally(() => { if (!controller.signal.aborted) setChecking(false) })
        return () => controller.abort()
      }, [revision])
      const statuses = value ? [value.projects.status, value.models.status] : []
      const problem = statuses.find(status => status !== 'ok')
      const heading = checking ? 'connectionChecking' : failed ? 'connectionFailed'
        : !problem ? 'connectionReady' : statuses.includes('ok') ? 'connectionPartial' : 'connectionFailed'
      const errors = {
        network: 'connectionNetwork', timeout: 'connectionTimeout', access: 'connectionAccess',
        address: 'connectionAddress', service: 'connectionService', response: 'connectionResponse',
      }
      const diagnostic = value ? [
        'OpenDirector DSH plugin ' + value.version,
        'API: ' + value.apiUrl, 'Canvas: ' + value.canvasUrl,
        'Projects: ' + value.projects.status + (value.projects.status === 'ok' ? ' (' + value.projects.count + ')' : ''),
        'Models: ' + value.models.status + (value.models.status === 'ok' ? ' (' + value.models.count + ')' : ''),
        ...(value.models.status === 'ok' ? Object.entries(value.models.capabilities).map(([kind, count]) => kind + ': ' + count) : []),
      ].join('\n') : ''
      async function copy() {
        try { await navigator.clipboard.writeText(diagnostic); setCopyState('connectionCopied') }
        catch { setCopyState('connectionCopyFailed') }
      }
      const capabilityNames = { image: 'connectionImage', imageEdit: 'connectionEdit',
        imageToVideo: 'connectionVideo', videoContinuation: 'connectionContinue', voiceover: 'connectionVoice' }
      return h('dialog', { ref: dialog, className: 'od-media-ui', 'aria-label': t('connection'), style: dialogStyle,
        onCancel: onClose },
        dialogHeader(t('connection'), onClose, t, t('connectionHint')),
        h('p', { role: 'status', style: { fontWeight: 600 } }, t(heading)),
        failed && h('p', { role: 'alert' }, t('connectionHost')),
        value && h('div', { style: { display: 'grid', gap: '.8rem' } },
          h('dl', { style: { margin: 0, display: 'grid', gap: '.35rem', overflowWrap: 'anywhere' } },
            h('dt', null, t('connectionApi')), h('dd', { style: { margin: 0 } }, h('code', null, value.apiUrl)),
            h('dt', null, t('connectionCanvas')), h('dd', { style: { margin: 0 } }, h('code', null, value.canvasUrl)),
            h('dt', null, t('connectionProjects')), h('dd', { style: { margin: 0 } },
              value.projects.status === 'ok' ? String(value.projects.count) : t(errors[value.projects.status])),
            h('dt', null, t('connectionModels')), h('dd', { style: { margin: 0 } },
              value.models.status === 'ok' ? t('connectionCount').replace('{count}', value.models.count) : t(errors[value.models.status]))),
          problem && h('p', { role: 'alert' }, t(errors[problem])),
          value.models.status === 'ok' && (value.models.count === 0
            ? h('p', null, t('connectionNoModels'))
            : h('div', null,
              h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))', gap: '.5rem' } },
                ...Object.entries(value.models.capabilities).map(([kind, count]) => h('div', {
                  key: kind, style: { border, borderRadius: '.65rem', padding: '.7rem' },
                }, h('small', { style: { color: muted } }, t(capabilityNames[kind])), h('div', { style: { fontSize: '1.3em' } }, count)))),
              h('small', { className: 'od-hint' }, t('connectionConfigured')))),
          h('div', { style: row }, h('a', { href: value.canvasUrl, className: 'od-button', style: buttonStyle,
            target: '_blank', rel: 'noopener noreferrer' }, t('connectionOpen'))),
          h('details', null, h('summary', null, t('connectionDiagnostic')),
            h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '.8em' } }, diagnostic),
            button(t('forgetRecent'), () => { forgetRecent(value.apiUrl); setForgotten(true) }),
            forgotten && h('p', { role: 'status' }, t('recentForgotten')))),
        h('p', { className: 'od-hint' }, t('connectionSetup')),
        h('div', { style: row },
          button(t('connectionCheck'), () => setRevision(v => v + 1), { disabled: checking }),
          value && button(t('connectionCopy'), copy, { disabled: checking }),
          openPlugin && button(t('connectionPlugin'), () => { onClose(); openPlugin() }),
          h('a', { href: 'https://github.com/ThinkFlowLab/OpenDirector/tree/main/plugins/deepseek-harness#configuration',
            target: '_blank', rel: 'noopener noreferrer', className: 'od-button', style: buttonStyle }, t('connectionGuide'))),
        copyState && h('p', { role: 'status' }, t(copyState)),
        h('small', { className: 'od-hint' }, t('connectionReadOnly')))
    }

    function PageControls({ cursor, nextCursor, disabled, onPage, t }) {
      const before = cursor.before ?? []
      if (!before.length && !nextCursor) return null
      return h('div', { style: { ...row, marginTop: '.7rem' } },
        button(t('previousPage'), () => onPage({ after: before.at(-1), before: before.slice(0, -1) }),
          { disabled: disabled || !before.length }),
        h('span', null, t('pageNumber').replace('{number}', before.length + 1)),
        button(t('nextPage'), () => onPage({ after: nextCursor, before: [...before, cursor.after ?? null] }),
          { disabled: disabled || !nextCursor }))
    }

    async function readLibrary(projectId, signal, filters = {}, after = null) {
      const query = projectId ? '?' + new URLSearchParams({
        project: projectId, ...filters, ...(after && { after }),
      }) : ''
      const response = await fetch('/api/opendirector/library' + query, { signal })
      if (!response.ok) throw new Error('Project read failed')
      return response.json()
    }

    function ProjectLibrary({ t, onClose }) {
      const dialog = useRef(null)
      const [projects, setProjects] = useState(null)
      const [scope, setScope] = useState('')
      const [projectId, setProjectId] = useState('')
      const [library, setLibrary] = useState(null)
      const [error, setError] = useState(false)
      const [pending, setPending] = useState(true)
      const [filters, setFilters] = useState(libraryDefaults)
      const [search, setSearch] = useState('')
      const [query, setQuery] = useState('')
      const [composing, setComposing] = useState(false)
      const [page, setPage] = useState({})
      const [view, setView] = useState('results')
      const [task, setTask] = useState(null)
      const [compareMode, setCompareMode] = useState(false)
      const [comparison, setComparison] = useState([])
      const [comparing, setComparing] = useState(false)
      const taskView = view === 'jobs'
      const searching = search.trim() !== query
      useEffect(() => {
        dialog.current.showModal()
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        setPending(true)
        setError(false)
        readLibrary(projectId, controller.signal, { ...filters, view, q: query }, page.after).then(value => {
          if (controller.signal.aborted) return
          if (projectId) setLibrary(value)
          else {
            setProjects(value.projects)
            setScope(value.scope)
            const recent = readRecent(value.scope)
            if (value.projects.some(project => project.id === recent.projectId)) setProjectId(recent.projectId)
            if (['results', 'jobs'].includes(recent.view)) setView(recent.view)
          }
          setPending(false)
        }).catch(() => {
          if (controller.signal.aborted) return
          setError(true)
          setPending(false)
        })
        return () => controller.abort()
      }, [projectId, filters, page, view, query])
      useEffect(() => {
        if (composing) return
        const timeout = setTimeout(() => {
          if (search.trim() === query) return
          setQuery(search.trim())
          setLibrary(null)
          setPage({})
        }, 250)
        return () => clearTimeout(timeout)
      }, [search, query, composing])
      const current = !searching && library?.projectId === projectId ? library : null
      const refresh = () => setPage({})
      const filtered = search.trim() || Object.keys(libraryDefaults).some(key => filters[key] !== libraryDefaults[key])
      function clearFilters() {
        setSearch('')
        setQuery('')
        setFilters(libraryDefaults)
        setLibrary(null)
        refresh()
      }
      function changeProject(id) {
        if (id) rememberRecent(scope, { projectId: id })
        setProjectId(id)
        setComparison([])
        setComparing(false)
        setLibrary(null)
        refresh()
      }
      function changeView(value) {
        rememberRecent(scope, { view: value })
        setView(value)
        setLibrary(null)
        refresh()
      }
      function toggleComparison(image) {
        setComparison(previous => previous.some(item => item.resultId === image.resultId)
          ? previous.filter(item => item.resultId !== image.resultId)
          : previous.length < 2 ? [...previous, image] : previous)
      }
      function filterControl(key, label, options) {
        return h('select', {
          value: filters[key], 'aria-label': t(label), title: t(label),
          onChange: event => {
            const value = event.target.value
            setFilters(previous => ({ ...previous, [key]: value }))
            setLibrary(null)
            refresh()
          },
        }, ...options.map(([value, text]) => h('option', { key: value, value }, t(text))))
      }
      return h('dialog', {
        className: 'od-media-ui',
        ref: dialog, onClose: event => { if (event.target === event.currentTarget) onClose() },
        'aria-label': t('resume'),
        style: dialogStyle,
      },
      dialogHeader(t('resume'), () => dialog.current.close(), t, t('libraryHint')),
      h(PendingSubmissions, { t, onRecovered: setTask }),
      h('div', { style: { ...row, marginBlock: '.7rem' } },
        projects?.length > 0 && h('select', {
          value: projectId, onChange: event => changeProject(event.target.value), 'aria-label': t('chooseProject'),
        },
        h('option', { value: '' }, t('chooseProject')),
        ...projects.map(({ id, name }) => h('option', { key: id, value: id }, name))),
        button(t('refresh'), refresh, { disabled: pending }),
        current && canvasLink(current.canvasUrl, t)),
      projectId && h('div', { style: { ...row, marginBlock: '.7rem' } },
        button(t('recent'), () => changeView('results'), { 'aria-pressed': !taskView }),
        button(t('tasks'), () => changeView('jobs'), { 'aria-pressed': taskView }),
        button(t('compareImages'), () => setCompareMode(value => !value), { 'aria-pressed': compareMode })),
      projectId && compareMode && h('section', { 'aria-label': t('compareImages'), style: { display: 'grid', gap: '.4rem', marginBlock: '.7rem' } },
        h('small', null, t('compareHint')),
        h('div', { style: row },
          ...comparison.map((image, index) => button((index + 1) + ' · ' + image.title + ' ×', () => toggleComparison(image), {
            key: image.resultId, 'aria-label': t('removeComparison') + ' ' + (index + 1),
          })),
          button(t('openComparison') + ' (' + comparison.length + '/2)', () => setComparing(true), { disabled: comparison.length !== 2 }),
          comparison.length > 0 && button(t('clearComparison'), () => setComparison([])))),
      projectId && h('div', { style: { ...row, marginBlock: '.7rem' } },
        h('input', { type: 'search', 'aria-label': t('searchLibrary'), placeholder: t('searchHint'),
          maxLength: 200, value: search, style: { flex: '1 1 18rem', minWidth: 0 },
          onChange: event => setSearch(event.target.value),
          onCompositionStart: () => setComposing(true),
          onCompositionEnd: event => { setComposing(false); setSearch(event.currentTarget.value) },
        }),
        filtered && button(t('clearFilters'), clearFilters)),
      projectId && h('div', { style: { ...row, marginBlock: '.7rem' } },
        filterControl('kind', 'libraryType', [['all', 'allMedia'], ['image', 'picture'], ['video', 'video'], ['audio', 'audio']]),
        taskView && filterControl('status', 'taskStatus', [['all', 'allTasks'], ['active', 'activeTasks'],
          ['succeeded', 'succeeded'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['interrupted', 'interrupted']]),
        !taskView && filterControl('selection', 'librarySelection', [['all', 'allSelections'], ['current', 'selected'], ['other', 'other']]),
        filterControl('order', 'libraryOrder', [['newest', 'newest'], ['oldest', 'oldest']])),
      (pending || searching) && h('p', { role: 'status' }, t('loading')),
      error && h('p', { role: 'alert' }, t('libraryError')),
      projects?.length === 0 && h('p', null, t('projectsEmpty')),
      current && h('section', { 'aria-label': t(taskView ? 'tasks' : 'recent') },
        h('h3', null, t(taskView ? 'tasks' : 'recent')),
        taskView ? (current.jobs.length === 0 ? h('p', null, t('tasksEmpty'))
          : h('div', { style: { display: 'grid', gap: '.65rem' } },
            ...current.jobs.map(job => h('article', {
              key: job.jobId, 'data-opendirector-job': job.jobId, style: { display: 'grid', gap: '.4rem', padding: '.65rem', border, borderRadius: '.55rem' },
            },
            h('strong', null, t(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)
              ? job.status : 'waiting')),
            job.title && h('span', null, job.title),
            h('small', { style: { color: muted } }, job.modelId),
            h('p', { style: { margin: 0, overflowWrap: 'anywhere' } }, job.prompt),
            button(t('viewTask'), () => setTask({ ...job, projectId, canvasUrl: current.canvasUrl }), { 'aria-haspopup': 'dialog' })))))
          : current.results.length === 0 ? h('p', null, t(!query && filters.kind === 'all' && filters.selection === 'all' ? 'resultsEmpty' : 'noMatches'))
          : h('div', { style: { display: 'grid', gap: '.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(15rem, 100%), 1fr))' } },
            ...current.results.map((candidate, index) => h(Preview, {
              ...candidate, key: candidate.resultId, projectId, t, canvasUrl: current.canvasUrl,
              title: candidate.title || (candidate.version ? t('candidate') : `${t('candidate')} ${index + 1}`),
              onAdopted: refresh,
              compareSelected: comparison.some(item => item.resultId === candidate.resultId),
              compareDisabled: comparison.length === 2 && !comparison.some(item => item.resultId === candidate.resultId),
              onCompare: compareMode && candidate.kind === 'image'
                ? () => toggleComparison({ resultId: candidate.resultId, title: candidate.title || candidate.resultId.slice(0, 8) }) : undefined,
            }))),
        h(PageControls, { cursor: page, nextCursor: current.nextCursor, disabled: pending, onPage: setPage, t })),
      comparing && h(ImageComparisonDialog, {
        projectId, resultIds: comparison.map(item => item.resultId), t, onAdopted: refresh,
        onClose: () => setComparing(false),
      }),
      task && (task.packId ? h(ActionPackDialog, { projectId: task.projectId, packId: task.packId,
        recovery: task.recovery, status: task.status, t, onClose: () => { setTask(null); refresh() } }) : h(GenerationDialog, {
        existingJob: task, t, onClose: () => { setTask(null); refresh() },
      })))
    }

    function ImageComparisonDialog({ projectId, resultIds, t, onClose, onAdopted }) {
      const dialog = useRef(null)
      const [value, setValue] = useState(null)
      const [failed, setFailed] = useState(false)
      const [revision, setRevision] = useState(0)
      const pair = resultIds.join(',')
      useEffect(() => { dialog.current.showModal() }, [])
      useEffect(() => {
        const controller = new AbortController()
        setFailed(false)
        fetch('/api/opendirector/library?' + new URLSearchParams({ project: projectId, compare: pair }),
          { signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error('Comparison unavailable')
          const result = await response.json()
          if (!controller.signal.aborted) setValue(result)
        }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
        return () => controller.abort()
      }, [projectId, pair, revision])
      return h('dialog', {
        className: 'od-media-ui',
        ref: dialog, 'aria-label': t('compareImages'),
        onClose: event => { if (event.target === event.currentTarget) onClose() },
        style: { ...dialogStyle, width: 'min(80rem, calc(100vw - 2rem))' },
      },
        dialogHeader(t('compareImages'), () => dialog.current.close(), t),
        !value && !failed && h('p', { role: 'status' }, t('loading')),
        failed && h('div', null, h('p', { role: 'alert' }, t('comparisonUnavailable')),
          button(t('refresh'), () => setRevision(previous => previous + 1))),
        value && !failed && h('div', { style: { display: 'grid', gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(24rem, 100%), 1fr))' } },
          ...value.images.map((image, index) => h(Preview, {
            ...image, key: image.resultId, projectId, t, expanded: true, canvasUrl: value.canvasUrl,
            title: (index + 1) + ' · ' + (image.title || t('candidate')),
            onAdopted: () => { setRevision(previous => previous + 1); onAdopted?.() },
          }))))
    }

    function ReferencePicker({ projectId, references, setReferences, limit, locked, t }) {
      const [open, setOpen] = useState(false)
      const [cursor, setCursor] = useState({})
      const [page, setPage] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(false)
      const full = references.length >= limit
      const pickerOpen = open && !locked && limit > 1
      useEffect(() => {
        if (!pickerOpen) return
        const controller = new AbortController()
        setLoading(true)
        setError(false)
        readLibrary(projectId, controller.signal, { kind: 'image' }, cursor.after).then(value => {
          if (controller.signal.aborted) return
          setPage(value)
          setLoading(false)
        }).catch(() => {
          if (controller.signal.aborted) return
          setError(true)
          setLoading(false)
        })
        return () => controller.abort()
      }, [pickerOpen, cursor, projectId])
      function toggle() {
        if (!open) {
          setCursor({})
          setPage(null)
        }
        setOpen(value => !value)
      }
      function add(image) {
        setReferences(previous => previous.length >= limit || previous.some(item => item.assetId === image.assetId)
          ? previous : [...previous, image])
      }
      function move(resultId, direction) {
        setReferences(previous => {
          const index = previous.findIndex(item => item.resultId === resultId)
          const destination = index + direction
          if (index < 1 || destination < 1 || destination >= previous.length) return previous
          const reordered = [...previous]
          reordered[index] = previous[destination]
          reordered[destination] = previous[index]
          return reordered
        })
      }
      const available = page?.results.filter(item => !references.some(reference => reference.assetId === item.assetId))
      const thumb = { width: '4rem', height: '4rem', objectFit: 'contain', display: 'block', borderRadius: '.3rem' }
      return h('section', { 'aria-label': t('references'), style: { display: 'grid', gap: '.4rem' } },
        limit > 1 && h('small', null, t('referenceOrder')),
        (limit > 1 || references.length > 1) && h('small', null, t('referenceLimit').replace('{count}', limit)),
        references.length > 1 && h('div', { style: row },
          ...references.slice(1).map(({ assetId, resultId }, index) => h('figure', { key: resultId, style: { margin: 0 } },
            h('img', { src: mediaHref(projectId, assetId, 'image'), alt: '', loading: 'lazy', style: thumb }),
            h('figcaption', null, `${t('referenceImage')} ${index + 2}`),
            h('div', { style: row },
              references.length > 2 && button('↑', () => move(resultId, -1), {
                disabled: locked || index === 0, 'aria-label': t('moveReferenceEarlier').replace('{number}', index + 2),
              }),
              references.length > 2 && button('↓', () => move(resultId, 1), {
                disabled: locked || index === references.length - 2, 'aria-label': t('moveReferenceLater').replace('{number}', index + 2),
              }),
              button('×', () => setReferences(previous => previous.filter(item => item.resultId !== resultId)), {
                disabled: locked, 'aria-label': `${t('removeReference')} ${index + 2}`,
              }))))),
        !locked && limit > 1 && h('div', null,
          button(t(open ? 'hideReferences' : 'chooseReferences'), toggle, { 'aria-expanded': open, disabled: full && !open })),
        pickerOpen && h('div', null,
          loading && h('p', { role: 'status' }, t('loading')),
          error && h('p', { role: 'alert' }, t('libraryError')),
          available?.length === 0 && !loading && h('p', null, t('noMoreImages')),
          h('div', { style: row }, ...(available ?? []).map((item, index) =>
            button(h('img', { src: mediaHref(projectId, item.assetId, 'image'), alt: '', loading: 'lazy', style: thumb }),
              () => add(item), { key: item.resultId, disabled: full, title: item.prompt || t('addReference'),
                'aria-label': `${t('addReference')} ${index + 1}` }))),
          page && h(PageControls, { cursor, nextCursor: page.nextCursor, disabled: loading || full, onPage: setCursor, t })))
    }


    async function readPack(projectId, packId, signal) {
      const response = await fetch('/api/opendirector/action-packs?' + new URLSearchParams({
        project: projectId, ...(packId && { pack: packId }),
      }), { signal })
      if (!response.ok) throw new Error('Pack unavailable')
      return response.json()
    }
    async function writePack(input) {
      const response = await fetch('/api/opendirector/action-packs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenDirector-Action': '1' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new Error('Pack request unavailable')
      return response.json()
    }


    const packStyles = `
      .od-pack-reference{display:flex;gap:1rem;align-items:center;margin:1rem 0;color:var(--dsw-alias-label-secondary)}
      .od-pack-reference img{width:5rem;height:5rem;object-fit:contain;border-radius:.7rem}
      .od-pack-form fieldset{display:grid;gap:.8rem;border:0;padding:0;min-width:0}
      .od-pack-form fieldset > .od-button{justify-self:start}
      .od-pack-form label{display:grid;gap:.35rem;min-width:0}
      .od-pack-action-input{display:grid;grid-template-columns:minmax(7rem,1fr) minmax(12rem,3fr) auto;gap:.6rem;padding:.8rem;border:1px solid #8884;border-radius:.7rem;align-items:center}
      .od-pack-form textarea{min-height:4rem;width:100%;box-sizing:border-box}
      .od-pack-form input,.od-pack-form select{max-width:100%;box-sizing:border-box}
      .od-pack-form button[type=submit]{justify-self:start}
      .od-pack-toolbar,.od-pack-summary{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}
      .od-pack-summary{padding:.8rem;border-bottom:1px solid #8884}
      .od-pack-summary strong{flex:1}
      .od-pack-action{min-width:0;margin:.2rem 0;padding:1rem;border:1px solid #8884;border-radius:1rem}
      .od-pack-candidates,.od-pack-source-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr));gap:1rem}
      .od-pack-actions-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(22rem,100%),1fr));gap:1rem}
      .od-action-pack .od-pack-candidates .od-preview:only-child{--od-preview-height:14rem}
      .od-pack-source{display:grid;background:transparent;color:inherit;border:1px solid #8884;border-radius:.8rem;cursor:pointer;padding:.7rem}
      .od-pack-source img{width:100%;height:9rem;object-fit:contain}
      .od-action-pack h3{margin:.3rem 0;flex:1}
      .od-action-pack .od-hint{overflow-wrap:anywhere}
      @media(max-width:600px){.od-pack-action-input{grid-template-columns:1fr}
      .od-pack-action{padding:.6rem}}
    `

    function ActionPackLibrary({ t, onClose }) {
      const dialog = useRef(null)
      const [projects, setProjects] = useState([])
      const [scope, setScope] = useState('')
      const [projectsRun, setProjectsRun] = useState(0)
      const [projectsLoading, setProjectsLoading] = useState(true)
      const [projectId, setProjectId] = useState('')
      const [packs, setPacks] = useState(null)
      const [sourcePicker, setSourcePicker] = useState(false)
      const [images, setImages] = useState(null)
      const [cursor, setCursor] = useState({})
      const [task, setTask] = useState(null)
      const [version, setVersion] = useState(0)
      const [error, setError] = useState(false)
      const [imageError, setImageError] = useState(false)
      useEffect(() => { if (!task) dialog.current.showModal() }, [task])
      useEffect(() => {
        const controller = new AbortController()
        setProjectsLoading(true); setError(false)
        readLibrary(null, controller.signal).then(value => {
          if (controller.signal.aborted) return
          setProjects(value.projects); setScope(value.scope)
          const recent = readRecent(value.scope)
          if (value.projects.some(project => project.id === recent.projectId)) setProjectId(recent.projectId)
        })
          .catch(() => { if (!controller.signal.aborted) setError(true) })
          .finally(() => { if (!controller.signal.aborted) setProjectsLoading(false) })
        return () => controller.abort()
      }, [projectsRun])
      useEffect(() => {
        if (!projectId) return
        const controller = new AbortController()
        setPacks(null); setError(false)
        readPack(projectId, null, controller.signal)
          .then(value => { if (!controller.signal.aborted) setPacks(value.packs) })
          .catch(() => { if (!controller.signal.aborted) setError(true) })
        return () => controller.abort()
      }, [projectId, version])
      useEffect(() => {
        setImages(null); setImageError(false)
        if (!projectId || !sourcePicker) return
        const controller = new AbortController()
        readLibrary(projectId, controller.signal, { kind: 'image' }, cursor.after)
          .then(value => { if (!controller.signal.aborted) setImages(value) })
          .catch(() => { if (!controller.signal.aborted) setImageError(true) })
        return () => controller.abort()
      }, [projectId, sourcePicker, cursor, version])
      if (task) return h(ActionPackDialog, { ...task, t, onClose: () => { setTask(null); setVersion(value => value + 1) } })
      return h('dialog', { ref: dialog, className: 'od-media-ui', style: dialogStyle, onCancel: onClose },
        dialogHeader(t('actionPacks'), onClose, t, t('packHint')),
        h(PendingSubmissions, { context: 'packs', t, onRecovered: value => setTask(value) }),
        h('label', null, t('chooseProject'), h('select', { 'aria-label': t('chooseProject'),
          value: projectId, onChange: event => { if (event.target.value) rememberRecent(scope, { projectId: event.target.value }); setProjectId(event.target.value); setCursor({}); setSourcePicker(false) },
        }, h('option', { value: '' }, t('chooseProject')), ...projects.map(project =>
          h('option', { key: project.id, value: project.id }, project.name)))),
        (error || imageError) && h('p', { role: 'alert' }, t('libraryError')),
        !projectId && projectsLoading && h('p', { role: 'status' }, t('loading')),
        !projectsLoading && !error && !projects.length && h('p', null, t('projectsEmpty')),
        h('div', { style: row },
          projectId && button(t('newActionPack'), () => setSourcePicker(value => !value), { primary: true }),
          button(t(projectId ? 'refresh' : 'reloadData'), () => projectId ? setVersion(value => value + 1) : setProjectsRun(value => value + 1), { disabled: projectsLoading })),
        projectId && !packs && !error && h('p', null, t('loading')),
        packs && !packs.length && h('p', null, t('packEmpty')),
        ...(packs ?? []).map(pack => h('article', { key: pack.packId, className: 'od-pack-summary' },
          h('strong', null, pack.title),
          h('span', null, t('packCount').replace('{selected}', pack.selectedCount).replace('{total}', pack.actionCount)),
          button(t('viewTask'), () => setTask({ projectId, packId: pack.packId })))),
        sourcePicker && h('section', { 'aria-label': t('packSelectSource') },
          h('h3', null, t('packSelectSource')),
          !images && !imageError && h('p', { role: 'status' }, t('loading')),
          images && !images.results.length && h('p', null, t('resultsEmpty')),
          h('div', { className: 'od-pack-source-grid' }, ...(images?.results ?? []).map(image =>
            h('button', { type: 'button', key: image.resultId, className: 'od-pack-source',
              'aria-label': t('packSource'), onClick: () => setTask({ source: { ...image, projectId } }) },
            h('img', { src: mediaHref(projectId, image.assetId, 'image'), alt: image.title || t('candidate'), loading: 'lazy' }),
            h('span', null, image.title || t('packSource'))))),
          h(PageControls, { cursor, nextCursor: images?.nextCursor, onPage: setCursor, t })))
    }

    function imageOutputSelection(model, requested) {
      const options = model?.imageOutputs ?? []
      const output = requested == null ? options[0] : options.find(item =>
        item.size === requested.size && item.aspectRatio === requested.aspectRatio)
      return { options, requested, output, unavailable: Boolean(model && requested && !output) }
    }

    function ImageOutputField({ selection, original, onChange, disabled, t }) {
      const { options, requested, output, unavailable } = selection
      const keepOriginal = original !== undefined
      if (!options.length && !unavailable && !keepOriginal) return null
      const value = keepOriginal && requested == null ? 'original' : unavailable ? '' : options.indexOf(output)
      return h('div', { style: { display: 'grid', gap: '.3rem' } },
        (options.length > 0 || keepOriginal) && h('label', { style: { display: 'grid', gap: '.3rem' } }, t('output'),
          h('select', { 'aria-label': t('output'), value, disabled,
            onChange: e => onChange(e.target.value === 'original' ? null : options[Number(e.target.value)]),
          }, keepOriginal && h('option', { value: 'original' }, [t('keepOriginalOutput'), original].filter(Boolean).join(' · ')),
          unavailable && h('option', { value: '', disabled: true }, t('chooseOutput')),
          ...options.map(({ size, aspectRatio }, i) => h('option', { key: i, value: i }, [size, aspectRatio].filter(Boolean).join(' · '))))),
        unavailable && h('p', { role: 'alert' }, t('outputUnavailable').replace('{size}', requested.size)),
        unavailable && !options.length && button(t(keepOriginal ? 'keepOriginalOutput' : 'useModelDefault'), () => onChange(null), { disabled }))
    }

    function ActionPackDialog({ source, projectId: suppliedProject, packId: suppliedPack, recovery, status: recoveredStatus, t, onClose }) {
      const dialog = useRef(null)
      const busy = useRef(false)
      const projectId = source?.projectId ?? suppliedProject
      const draftKey = 'pack-create:' + projectId + ':' + source?.resultId
      const [packId, setPackId] = useState(suppliedPack ?? null)
      const [pack, setPack] = useState(null)
      const [catalog, setCatalog] = useState(null)
      const [initialDraft] = useState(() => readMediaDraft(draftKey))
      const catalogInitialized = useRef(Boolean(initialDraft))
      const [dirty, setDirty] = useState(Boolean(initialDraft))
      const [form, setForm] = useState(() => initialDraft?.form ?? {
        title: t('packDefaultTitle'), prompt: '', kind: 'image', modelId: '', output: null,
        durationSeconds: null, actions: [
          { name: t('packIdle'), prompt: t('packIdlePrompt') },
          { name: t('packWave'), prompt: t('packWavePrompt') },
          { name: t('packThink'), prompt: t('packThinkPrompt') },
        ],
      })
      const [submitting, setSubmitting] = useState(false)
      const [feedback, setFeedback] = useState('')
      const [version, setVersion] = useState(0)
      const [pages, setPages] = useState({})
      const [comparison, setComparison] = useState([])
      const [comparing, setComparing] = useState(false)
      const [editing, setEditing] = useState(null)
      const editDraftKey = itemId => 'pack-revise:' + projectId + ':' + packId + ':' + itemId
      const pending = useSyncExternalStore(subscribePending, readPendingSubmissions)
      const pendingItems = pending.filter(item => item.context === (packId ? 'pack:' + packId : draftKey))
      const pendingItem = pendingItems[0]
      const locked = submitting || Boolean(pendingItem)
      const refresh = () => setVersion(value => value + 1)
      useEffect(() => { dialog.current.showModal() }, [])
      useEffect(() => {
        if (recovery && packId) {
          if (recovery.packAction === 'prepare' || ['applied', 'accepted', 'noop', 'rejected'].includes(recoveredStatus)) forgetSubmission(recovery)
        }
      }, [recovery, packId, recoveredStatus])
      useEffect(() => {
        if (packId || !source || pendingItem) return
        const controller = new AbortController()
        setCatalog(null)
        fetch('/api/opendirector/creation', { signal: controller.signal }).then(response => {
          if (!response.ok) throw new Error('Catalog unavailable')
          return response.json()
        }).then(value => {
          if (controller.signal.aborted) return
          setCatalog(value)
          if (!catalogInitialized.current) {
            const kind = ['image', 'video'].includes(readRecent(value.scope).packKind) ? readRecent(value.scope).packKind : 'image'
            setForm(previous => ({ ...previous, kind,
              ...recentSetup(value, 'pack:' + kind, kind, kind === 'video' ? 'first_frame' : undefined),
            }))
          }
          catalogInitialized.current = true
        }).catch(() => { if (!controller.signal.aborted) setCatalog({ error: true, models: [] }) })
        return () => controller.abort()
      }, [packId, Boolean(pendingItem), version])
      useEffect(() => {
        if (!packId && !locked) saveMediaDraft(draftKey, dirty ? { form } : null)
      }, [packId, locked, form, draftKey, dirty])
      useEffect(() => {
        if (!packId) return
        const controller = new AbortController()
        let timer, inFlight = false
        async function update() {
          if (inFlight || document.visibilityState === 'hidden' || !navigator.onLine) return
          inFlight = true
          try {
            const value = await readPack(projectId, packId, controller.signal)
            if (controller.signal.aborted) return
            setPack(value)
            if (value.active) timer = setTimeout(update, 2500)
          } catch { if (!controller.signal.aborted) setFeedback('progressUnavailable') }
          finally { inFlight = false }
        }
        update()
        const visible = () => { clearTimeout(timer); update() }
        document.addEventListener('visibilitychange', visible)
        window.addEventListener('online', visible)
        return () => {
          clearTimeout(timer); controller.abort()
          document.removeEventListener('visibilitychange', visible)
          window.removeEventListener('online', visible)
        }
      }, [packId, projectId, version])
      const choices = catalog?.models.filter(model => model.kind === form.kind
        && (form.kind === 'image' ? model.maxImages > 0 : model.videoChoices?.first_frame)) ?? []
      const model = choices.find(model => model.id === form.modelId)
      const imageSize = imageOutputSelection(model, form.output)
      const video = model?.videoChoices?.first_frame
      const names = form.actions.map(action => action.name.trim().normalize('NFKC').toLowerCase())
      const missing = !catalog ? 'loading' : catalog.error ? 'libraryError' : !choices.length ? 'noModels'
        : !model ? 'needsModel' : imageSize.unavailable ? 'chooseOutput'
        : !form.title.trim() || names.some(name => !name) || new Set(names).size !== names.length
          || form.actions.some(action => !action.prompt.trim()) ? 'packInvalid' : null
      function change(key, value) {
        setDirty(true)
        if (['kind', 'modelId', 'output', 'durationSeconds'].includes(key)) catalogInitialized.current = true
        setForm(previous => ({ ...previous, [key]: value,
          ...(key === 'modelId' && { durationSeconds: null }),
          ...(key === 'kind' && { modelId: '', output: null, durationSeconds: null,
            ...recentSetup(catalog, 'pack:' + value, value, value === 'video' ? 'first_frame' : undefined) }),
        }))
      }
      useEffect(() => {
        if (packId || locked || !model || imageSize.unavailable) return
        rememberRecent(catalog.scope, { projectId, packKind: form.kind, setups: { ['pack:' + form.kind]: {
          modelId: model.id, output: form.kind === 'image' ? imageSize.output ?? null : null,
          durationSeconds: form.durationSeconds ?? video?.defaultDuration ?? null,
        } } })
      }, [packId, locked, model?.id, form.kind, form.output, form.durationSeconds, catalog?.scope, projectId])
      async function submitActions(id, itemIds, redo = false, original) {
        const input = { action: 'generate', projectId, packId: id,
          operationId: original?.operationId ?? crypto.randomUUID(), itemIds, redo }
        const saved = { ...input, packAction: 'generate', packItemIds: itemIds, packRedo: redo }
        rememberSubmission(saved, 'pack:' + id, pack?.title ?? form.title)
        let value
        try { value = await writePack(input) } catch { value = { status: 'unknown' } }
        if (value.status !== 'unknown') forgetSubmission(saved)
        setFeedback(value.status === 'unknown' ? 'generationUnknown' : value.status === 'rejected'
          ? packError(value.code) : '')
        refresh()
      }
      async function generate(itemIds, redo, original) {
        if (busy.current) return
        busy.current = true; setSubmitting(true)
        try { await submitActions(packId, itemIds, redo, original) }
        finally { busy.current = false; setSubmitting(false) }
      }
      async function prepare(event) {
        event.preventDefault()
        if (busy.current || pendingItem || missing) return
        busy.current = true; setSubmitting(true); setFeedback('')
        const input = { action: 'prepare', projectId, operationId: crypto.randomUUID(),
          sourceResultId: source.resultId, title: form.title, sharedPrompt: form.prompt,
          actions: form.actions, modelConfigId: form.modelId,
          ...(imageSize.output && { output: imageSize.output }),
          ...(video && { durationSeconds: form.durationSeconds ?? video.defaultDuration }),
        }
        const saved = { ...input, packAction: 'prepare' }
        rememberSubmission(saved, draftKey, form.title)
        try {
          let value
          try { value = await writePack(input) } catch { value = { status: 'unknown' } }
          if (value.status === 'unknown') { setFeedback('generationUnknown'); return }
          forgetSubmission(saved)
          if (value.status === 'rejected') { setFeedback(packError(value.code)); return }
          setPackId(value.packId)
          saveMediaDraft(draftKey, null); flushMediaDrafts()
          const current = await readPack(projectId, value.packId)
          setPack(current)
          await submitActions(value.packId, current.actions.map(action => action.itemId))
        } catch { setFeedback('progressUnavailable') }
        finally { busy.current = false; setSubmitting(false) }
      }
      function recovered(value) {
        setPackId(value.packId); setPack(value)
        setFeedback(value.status === 'unknown' ? 'generationUnknown' : '')
        if (value.status !== 'unknown') forgetSubmission(value.recovery)
        if (value.recovery.packAction === 'revise' && value.status !== 'unknown') {
          if (['applied', 'accepted', 'noop'].includes(value.status)) {
            saveMediaDraft(editDraftKey(value.recovery.packItemIds[0]), null)
            setEditing(null); setFeedback('packRevised')
          } else setFeedback(packError(value.code))
        }
        if (value.recovery.packAction === 'prepare') {
          saveMediaDraft(draftKey, null); flushMediaDrafts()
        }
        refresh()
      }
      function changeAction(action) {
        const draft = readMediaDraft(editDraftKey(action.itemId))?.form
        setEditing(draft?.itemId === action.itemId ? draft
          : { itemId: action.itemId, prompt: action.prompt, revision: action.revision })
      }
      function cancelEdit() {
        if (editing) saveMediaDraft(editDraftKey(editing.itemId), null)
        setEditing(null)
      }
      useEffect(() => {
        if (editing) saveMediaDraft(editDraftKey(editing.itemId), { form: editing })
      }, [editing, packId])
      async function revise(event) {
        event.preventDefault()
        if (busy.current || !editing || pendingItem) return
        busy.current = true; setSubmitting(true); setFeedback('')
        const input = { action: 'revise', projectId, packId, operationId: crypto.randomUUID(),
          itemId: editing.itemId, prompt: editing.prompt, expectedSpecRevision: editing.revision }
        const saved = { ...input, packAction: 'revise', packItemIds: [editing.itemId] }
        rememberSubmission(saved, 'pack:' + packId, pack.title)
        try {
          let value
          try { value = await writePack(input) } catch { value = { status: 'unknown' } }
          if (value.status === 'unknown') { setFeedback('generationUnknown'); return }
          forgetSubmission(saved)
          if (value.status === 'rejected') { setFeedback(packError(value.code)); return }
          const itemId = editing.itemId
          cancelEdit()
          await submitActions(packId, [itemId], true)
        } finally { busy.current = false; setSubmitting(false); refresh() }
      }
      const remaining = pack?.actions.filter(action => !action.jobs.length) ?? []
      const sourceImage = source ?? pack?.actions[0]?.reference
      return h('dialog', { ref: dialog, className: 'od-media-ui od-action-pack', 'aria-label': t('newActionPack'),
        style: packId ? { ...dialogStyle, width: 'min(80rem, calc(100vw - 2rem))' } : dialogStyle,
        onCancel: e => { if (e.target === e.currentTarget) onClose() } },
        dialogHeader(pack?.title ?? t('newActionPack'), onClose, t, t('packHint')),
        sourceImage && h('div', { className: 'od-pack-reference' },
          h('img', { src: mediaHref(projectId, sourceImage.assetId, 'image'), alt: t('packReference') }),
          h('span', null, t('packReference'))),
        h(PendingSubmissions, { context: packId ? 'pack:' + packId : draftKey, onRecovered: recovered, disabled: submitting, t }),
        feedback && h('p', { role: 'status' }, t(feedback)),
        pendingItem?.packAction === 'generate' && button(t('packContinue'),
          () => generate(pendingItem.packItemIds, pendingItem.packRedo, pendingItem), { disabled: submitting }),
        !packId && !pendingItem && !catalog && h('p', { role: 'status' }, t('loading')),
        !packId && !pendingItem && catalog?.error && h('p', { role: 'alert' }, t('libraryError')),
        !packId && !pendingItem && h('form', { onSubmit: prepare, className: 'od-pack-form' },
          h('fieldset', { disabled: locked },
            h('label', null, t('packTitle'), h('input', { required: true, maxLength: 100, value: form.title, onChange: e => change('title', e.target.value) })),
            h('label', null, t('packShared'), h('textarea', { maxLength: 4000, value: form.prompt, onChange: e => change('prompt', e.target.value) })),
            h('div', { style: row },
              h('label', null, t('mediaType'), h('select', { 'aria-label': t('mediaType'), value: form.kind, onChange: e => change('kind', e.target.value) },
                h('option', { value: 'image' }, t('picture')), h('option', { value: 'video' }, t('video')))),
              h('label', null, t('model'), h('select', { name: 'model', 'aria-label': t('model'), required: true, value: form.modelId, onChange: e => change('modelId', e.target.value) },
                h('option', { value: '' }, t('chooseModel')), ...choices.map(model =>
                  h('option', { key: model.id, value: model.id }, model.modelId)))),
              form.kind === 'image' && h(ImageOutputField, { selection: imageSize,
                onChange: value => change('output', value), disabled: locked, t }),
              video?.durations.length > 0 && h('label', null, t('videoDuration'), h('select', {
                'aria-label': t('videoDuration'), value: form.durationSeconds ?? video.defaultDuration ?? video.durations[0],
                onChange: e => change('durationSeconds', Number(e.target.value)),
              }, ...video.durations.map(seconds => h('option', { key: seconds, value: seconds }, t('duration').replace('{seconds}', seconds)))))),
            catalog && !choices.length && h('div', { style: row },
              !catalog.error && h('p', null, t('noModels')),
              button(t('reloadData'), refresh, { disabled: locked })),
            !locked && h(ActionExamples, { t, onApply: actions => change('actions', actions) }),
            ...form.actions.map((action, index) => h('div', { key: index, className: 'od-pack-action-input' },
              h('label', null, t('packActionName'), h('input', { required: true, maxLength: 80, value: action.name,
                onChange: e => change('actions', form.actions.map((value, i) => i === index ? { ...value, name: e.target.value } : value)) })),
              h('label', null, t('packDescription'), h('textarea', { required: true, maxLength: 4000, value: action.prompt,
                onChange: e => change('actions', form.actions.map((value, i) => i === index ? { ...value, prompt: e.target.value } : value)) })),
              button(t('packRemove'), () => change('actions', form.actions.filter((_, i) => i !== index)), { disabled: form.actions.length === 1 }))),
            button(t('packAdd'), () => change('actions', [...form.actions, { name: '', prompt: '' }]), { disabled: form.actions.length >= 6 }),
            h(SubmitRow, { label: t(submitting ? 'submitting' : 'packCreate').replace('{count}', form.actions.length),
              reason: missing && t(missing), focusModel: missing === 'needsModel', busy: locked }))),
        packId && !pack && h('p', null, t('loading')),
        pack && h('section', null,
          h('div', { className: 'od-pack-toolbar' },
            h('strong', null, t('packCount').replace('{selected}', pack.selectedCount).replace('{total}', pack.actions.length)),
            button(t('refresh'), refresh, { disabled: submitting }),
            remaining.length > 0 && button(t('packMissing').replace('{count}', remaining.length),
              () => generate(remaining.map(action => action.itemId), false), { primary: true, disabled: locked }),
            pack.actions.length > 0 && pack.selectedCount === pack.actions.length
              && h('a', { href: '/api/opendirector/action-packs?' + new URLSearchParams({ project: projectId, pack: packId, download: '1' }),
                className: 'od-button od-primary', download: '', style: { ...buttonStyle, textDecoration: 'none' } }, t('packExport'))),
          h('p', { className: 'od-hint' }, t('packExportHint')),
          h('div', { className: 'od-pack-actions-grid' }, ...pack.actions.map(action => {
            const page = pages[action.itemId] ?? 0
            const results = [...action.results].reverse().slice(page * 4, page * 4 + 4)
            const active = action.jobs.filter(job => ['queued', 'running'].includes(job.status))
            return h('article', { key: action.itemId, className: 'od-pack-action', 'data-pack-action': action.itemId },
              h('div', { className: 'od-pack-toolbar' }, h('h3', null, action.name),
                h('span', { role: 'status' }, t(action.status === 'not_started' ? 'packNotStarted' : action.status)),
                button(t(action.jobs.length ? 'repeatGeneration' : 'generate'),
                  () => generate([action.itemId], Boolean(action.jobs.length)), { disabled: locked || !action.canGenerate }),
                button(t('packRevise'), () => changeAction(action), { disabled: locked || !action.canRevise })),
              h('details', { className: 'od-hint' }, h('summary', null, t('generationSettings')), h('p', null, action.prompt)),
              editing?.itemId === action.itemId && h('form', { onSubmit: revise },
                h('label', { style: { display: 'grid', gap: '.4rem' } }, t('packEditPrompt'),
                  h('textarea', { required: true, maxLength: 20000, 'aria-label': t('packEditPrompt'),
                    style: { width: '100%', minHeight: '8rem', boxSizing: 'border-box' }, disabled: locked,
                    value: editing.prompt, onChange: event => setEditing(previous => ({ ...previous, prompt: event.target.value })) })),
                h('div', { style: row },
                  h('button', { type: 'submit', className: 'od-button od-primary', style: buttonStyle,
                    disabled: locked || !editing.prompt.trim() }, t('packSaveGenerate')),
                  button(t('packCancelEdit'), cancelEdit, { disabled: locked }))),
              ...active.map(job => h(JobCancellation, { key: job.jobId, projectId, jobId: job.jobId, progress: job, t, onChange: refresh })),
              ['failed', 'interrupted'].includes(action.status) && h('p', null, t(generationMessages.get(action.jobs.at(-1)?.category) ?? 'recoverOnCanvas')),
              h('div', { className: 'od-pack-candidates' }, ...results.map((result, index) => h(Preview, {
                ...result, key: result.resultId, projectId, title: t(result.selected ? 'selected' : 'candidate') + ' ' + (action.results.length - page * 4 - index),
                t, onAdopted: refresh, canvasUrl: pack.canvasUrl, compactActions: true,
                onCompare: action.kind === 'image' ? () => setComparison(previous =>
                  previous.some(item => item.resultId === result.resultId) ? previous.filter(item => item.resultId !== result.resultId)
                    : previous[0]?.itemId !== action.itemId ? [{ itemId: action.itemId, resultId: result.resultId }]
                      : [...previous, { itemId: action.itemId, resultId: result.resultId }].slice(0, 2)) : undefined,
                compareSelected: comparison.some(item => item.resultId === result.resultId),
                compareDisabled: comparison.length === 2 && comparison[0]?.itemId === action.itemId && !comparison.some(item => item.resultId === result.resultId),
              }))),
              action.results.length > 4 && h('div', { style: row },
                button(t('previousPage'), () => setPages(previous => ({ ...previous, [action.itemId]: page - 1 })), { disabled: page === 0 }),
                button(t('nextPage'), () => setPages(previous => ({ ...previous, [action.itemId]: page + 1 })), { disabled: (page + 1) * 4 >= action.results.length })))
          })),
          comparison.length === 2 && button(t('openComparison'), () => setComparing(true)),
          pack.canvasUrl && canvasLink(pack.canvasUrl, t)),
        comparing && h(ImageComparisonDialog, { projectId, resultIds: comparison.map(item => item.resultId),
          onAdopted: refresh, t, onClose: () => setComparing(false) }))
    }
    function packError(code) {
      if (code === 'storage_busy') return 'adoptBusy'
      if (['pack.plan', 'input.string', 'input.required'].includes(code)) return 'packInvalid'
      if (code === 'pack.model') return 'noModels'
      if (code === 'pack.active') return 'packActive'
      if (submissionMessages.has(code)) return submissionMessages.get(code)
      if (code === 'creation.output') return 'chooseOutput'
      return 'failedToSubmit'
    }

    function ExamplePicker({ mode, t, prompt, onApply }) {
      const [replacement, setReplacement] = useState(null)
      const ids = mode === 'audio' ? ['Speech', 'Narration'] : mode === 'edit' ? ['Lamp', 'Evening']
        : mode === 'first_frame' ? ['Wave', 'Push'] : mode === 'continuation' ? ['Continue'] : ['Studio', 'Character', 'Cover']
      return h('div', { 'data-opendirector-examples': mode },
        h('div', { style: row }, h('small', null, t('examples')),
          ...ids.map(id => button(t('example' + id), () => {
            if (prompt.trim()) setReplacement(id)
            else { setReplacement(null); onApply(t('example' + id + 'Prompt')) }
          }, { key: id }))),
        replacement && h('div', { className: 'od-settings' },
          h('p', null, t('example' + replacement + 'Prompt')),
          button(t('exampleReplace'), () => { onApply(t('example' + replacement + 'Prompt')); setReplacement(null) }),
          button(t('packCancelEdit'), () => setReplacement(null))))
    }

    function ActionExamples({ t, onApply }) {
      const [choice, setChoice] = useState('starter')
      const keys = choice === 'starter' ? ['Idle', 'Wave', 'Think'] : ['Happy', 'Think', 'Sleep']
      return h('details', { className: 'od-settings', 'data-opendirector-action-examples': '' },
        h('summary', null, t('actionExamples')),
        h('div', { style: { display: 'grid', gap: '.5rem', marginTop: '.6rem' } },
          h('select', { 'aria-label': t('actionExamples'), value: choice, onChange: e => setChoice(e.target.value) },
            h('option', { value: 'starter' }, t('actionExampleStarter')), h('option', { value: 'mood' }, t('actionExampleMood'))),
          h('span', null, keys.map(key => t('pack' + key)).join(' · ')),
          h('small', { className: 'od-hint' }, t('actionExamplesHint')),
          h('div', { style: row }, button(t('actionExampleApply'),
            () => onApply(keys.map(key => ({ name: t('pack' + key), prompt: t('pack' + key + 'Prompt') })))))))
    }

    function GenerationDialog({ source, videoMode, existingJob, templateOf, t, onClose }) {
      const dialog = useRef(null)
      const busy = useRef(false)
      const attempt = useRef(null)
      const [catalog, setCatalog] = useState(null)
      const draftKey = existingJob ? ['repeat', existingJob.projectId, existingJob.jobId].join(':') : templateOf ? ['reuse', templateOf.projectId, templateOf.resultId].join(':') : source ? [videoMode ?? 'edit', source.projectId, source.resultId].join(':') : 'create'
      const pending = useSyncExternalStore(subscribePending, readPendingSubmissions)
      const [recoveredJob, setRecoveredJob] = useState(null)
      const [startFresh, setStartFresh] = useState(false)
      const restoringPending = !startFresh && !attempt.current && pending.some(item => item.context === draftKey)
      const defaults = {
        kind: templateOf?.kind ?? (videoMode ? 'video' : 'image'), projectId: '', projectName: '', modelId: '',
        prompt: '', output: null, voice: '', durationSeconds: null, candidateCount: 1,
      }
      const [saved] = useState(() => existingJob ? null : readMediaDraft(draftKey))
      const catalogInitialized = useRef(Boolean(saved))
      const [catalogRun, setCatalogRun] = useState(0)
      const [restored, setRestored] = useState(Boolean(saved))
      const [recentRestored, setRecentRestored] = useState(false)
      const [recentBase, setRecentBase] = useState(null)
      const [form, setForm] = useState(() => ({ ...defaults, ...saved?.form }))
      const [result, setResult] = useState(existingJob ?? null)
      const [progress, setProgress] = useState(null)
      const [repeatStatus, setRepeatStatus] = useState(null)
      const [repeatCount, setRepeatCount] = useState(1)
      const [packSource, setPackSource] = useState(null)
      const packTrigger = useRef(null)
      const [comparison, setComparison] = useState([])
      const [comparing, setComparing] = useState(false)
      const [submitting, setSubmitting] = useState(false)
      const [pollError, setPollError] = useState(false)
      const [updatesPaused, setUpdatesPaused] = useState(false)
      const [pollRun, setPollRun] = useState(0)
      const [references, setReferences] = useState(() => source && !videoMode
        ? [source, ...(Array.isArray(saved?.references) ? saved.references.filter(item => item?.kind === 'image'
          && typeof item.resultId === 'string' && typeof item.assetId === 'string' && item.resultId !== source.resultId) : [])] : [])
      const fromResult = Boolean(source)
      const continuation = videoMode === 'continuation'
      const title = t(existingJob ? 'taskProgress' : templateOf ? 'reuseSettings' : continuation ? 'continue' : videoMode ? 'firstFrame' : fromResult ? 'edit' : 'create')
      const choices = catalog?.models.filter(model => model.kind === form.kind
        && (videoMode ? model.videoChoices?.[videoMode] : !source || model.maxImages > 0))
      const model = choices?.find(item => item.id === form.modelId)
      const video = model?.videoChoices?.[videoMode]
      const durationSeconds = form.durationSeconds ?? video?.defaultDuration
      const durationUnavailable = Boolean(video && form.durationSeconds !== null && !video.durations.includes(durationSeconds))
      const imageSize = imageOutputSelection(model, form.output)
      const { output, unavailable: outputUnavailable } = imageSize
      const referenceLimit = model?.maxImages ?? 1
      const tooManyReferences = Boolean(model) && references.length > referenceLimit
      const jobId = result?.jobId
      const projectId = result?.projectId
      const groupId = result?.groupId
      const unknown = result?.status === 'unknown'
      const locked = submitting || unknown || Boolean(jobId) || result?.draftSaved === true
      const draftBase = catalog?.template ? { ...defaults, projectId: templateOf.projectId,
        kind: catalog.template.kind, modelId: catalog.template.modelConfigId,
        prompt: catalog.template.prompt, voice: catalog.template.voice } : recentBase ?? defaults
      const dirty = Object.keys(defaults).some(key => form[key] !== draftBase[key])
        || references.length > (source && !videoMode ? 1 : 0)
      const projectUnavailable = !source && !templateOf && catalog && !catalog.error && form.projectId && form.projectId !== 'new'
        && !catalog.projects.some(project => project.id === form.projectId)
      const modelUnavailable = catalog && !catalog.error && form.modelId && !model
      const missing = projectUnavailable ? 'projectUnavailable' : !source && !templateOf && !form.projectId ? 'needsProject'
        : form.projectId === 'new' && !form.projectName.trim() ? 'needsName'
        : !choices?.length ? 'noModels' : modelUnavailable ? 'modelUnavailable' : !model ? 'needsModel'
        : tooManyReferences ? 'referencesChanged' : outputUnavailable ? 'chooseOutput'
        : durationUnavailable ? 'chooseDuration' : model.voiceRequired && !form.voice.trim() ? 'needsVoice'
        : !form.prompt.trim() ? 'needsPrompt' : null
      useEffect(() => {
        if (existingJob || restoringPending || recoveredJob) return
        saveMediaDraft(draftKey, !locked && dirty ? { form, references } : null)
      }, [draftKey, form, references, locked, existingJob, dirty, restoringPending, recoveredJob])
      function clearDraft() {
        setForm(draftBase)
        setReferences(source && !videoMode ? [source] : [])
        setRestored(false)
        saveMediaDraft(draftKey, null)
        flushMediaDrafts()
      }
      const update = (key, value) => setForm(previous => ({ ...previous, [key]: value,
        ...(key === 'kind' && { modelId: '', output: null, durationSeconds: null,
          ...recentSetup(catalog, value, value) }),
        ...((key === 'kind' || key === 'modelId') && { voice: '' }),
      }))
      useEffect(() => {
        if (existingJob || templateOf || videoMode === 'continuation' || locked || !model || outputUnavailable || !catalog?.scope) return
        const context = videoMode ?? (source ? 'edit' : form.kind)
        const chosenProject = source?.projectId
          ?? (catalog.projects?.some(project => project.id === form.projectId) ? form.projectId : undefined)
        rememberRecent(catalog.scope, {
          ...(!source && { kind: form.kind }), ...(chosenProject && { projectId: chosenProject }),
          setups: { [context]: { modelId: model.id, output: form.kind === 'image' ? output ?? null : null,
            durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null } },
        })
      }, [existingJob, templateOf, locked, model?.id, form.kind, form.projectId, form.output, form.durationSeconds, catalog?.scope])

      useLayoutEffect(() => {
        if (packSource || recoveredJob) return
        dialog.current.showModal()
        if (packTrigger.current) {
          dialog.current.querySelector(`[data-opendirector-result="${CSS.escape(packTrigger.current)}"] [aria-haspopup=menu]`)?.focus()
          packTrigger.current = null
        }
      }, [packSource, recoveredJob])
      useEffect(() => {
        if (existingJob || restoringPending || recoveredJob) return
        const controller = new AbortController()
        setCatalog(null)
        Promise.all([
          (fromResult || templateOf) ? Promise.resolve({ projects: [] }) : readLibrary(null, controller.signal),
          fetch('/api/opendirector/creation', { signal: controller.signal }).then(response => {
            if (!response.ok) throw new Error('Model catalog unavailable')
            return response.json()
          }),
          templateOf ? fetch('/api/opendirector/creation?' + new URLSearchParams({
            project: templateOf.projectId, reuse: templateOf.resultId,
          }), { signal: controller.signal }).then(response => {
            if (!response.ok) throw new Error('Saved settings unavailable')
            return response.json()
          }) : Promise.resolve(null),
        ]).then(([projects, models, template]) => {
          if (controller.signal.aborted) return
          setCatalog({ ...projects, ...models, ...(template && { template }) })
          const initialize = !catalogInitialized.current
          if (template) setForm(previous => ({ ...previous,
            kind: template.kind, projectId: templateOf.projectId, modelId: template.modelConfigId,
            ...(initialize && { prompt: template.prompt, voice: template.voice }),
          }))
          else if (initialize) {
            const recent = readRecent(models.scope)
            const kind = !source && ['image', 'audio'].includes(recent.kind) ? recent.kind : defaults.kind
            const preferred = videoMode === 'continuation' ? {} : recentSetup(models, videoMode ?? (source ? 'edit' : kind), kind, videoMode)
            const preferredProject = !source && projects.projects.some(project => project.id === recent.projectId) ? recent.projectId : ''
            const restoredForm = { ...defaults, kind, ...preferred, ...(preferredProject && { projectId: preferredProject }) }
            setRecentBase(restoredForm)
            setForm(restoredForm)
            setRecentRestored(Boolean(preferred.modelId || preferredProject))
          }
          catalogInitialized.current = true
        }).catch(() => {
          if (!controller.signal.aborted) setCatalog({ error: true, projects: [], models: [] })
        })
        return () => controller.abort()
      }, [fromResult, existingJob, templateOf?.projectId, templateOf?.resultId, restoringPending, recoveredJob, catalogRun])
      useEffect(() => {
        if (existingJob?.recovery && (!existingJob.groupId || existingJob.groupComplete)) forgetSubmission(existingJob.recovery)
      }, [existingJob?.recovery])
      useEffect(() => {
        if (!jobId || recoveredJob) return
        const controller = new AbortController()
        let timer
        let inFlight = false
        let active = true
        const available = () => !document.hidden && navigator.onLine !== false
        async function poll() {
          if (controller.signal.aborted || inFlight || !available()) return
          inFlight = true
          try {
            const params = new URLSearchParams({ project: projectId, ...(groupId ? { group: groupId } : { job: jobId }) })
            const response = await fetch('/api/opendirector/creation?' + params, { signal: controller.signal })
            if (!response.ok) throw new Error('Job status unavailable')
            const value = await response.json()
            if (controller.signal.aborted) return
            active = ['accepted', 'queued', 'running'].includes(value.status)
            setPollError(false)
            setProgress(previous => ({ ...value, jobId, results: value.results ?? previous?.results ?? [] }))
            if (active && available()) timer = setTimeout(poll, 2500)
          } catch {
            if (!controller.signal.aborted) setPollError(true)
          } finally {
            inFlight = false
          }
        }
        function wake() {
          clearTimeout(timer)
          setUpdatesPaused(!available())
          if (active) poll()
        }
        document.addEventListener('visibilitychange', wake)
        window.addEventListener('online', wake)
        window.addEventListener('offline', wake)
        wake()
        return () => {
          controller.abort()
          clearTimeout(timer)
          document.removeEventListener('visibilitychange', wake)
          window.removeEventListener('online', wake)
          window.removeEventListener('offline', wake)
        }
      }, [jobId, projectId, groupId, pollRun, recoveredJob])
      useEffect(() => {
        // Saved group members also prove acceptance when a reply was lost.
        // This only reconciles the display; it never submits remaining work.
        if (!groupId || !result.requestedCount || !progress?.totalCount
          || progress.totalCount <= (result.acceptedCount ?? 0)) return
        const complete = progress.totalCount >= result.requestedCount
        setResult(previous => ({ ...previous, acceptedCount: progress.totalCount,
          ...(complete && { status: 'accepted', groupComplete: true, canContinueGroup: false }) }))
        if (complete) {
          forgetSubmission({ projectId, operationId: groupId })
          if (!busy.current) attempt.current = null
        }
      }, [groupId, projectId, result?.requestedCount, result?.acceptedCount, progress?.totalCount])
      async function send(makeAttempt) {
        if (busy.current) return
        // Accepted and uncertain submissions belong in task recovery, never in a new-input draft.
        if (!existingJob) {
          saveMediaDraft(draftKey, null)
          flushMediaDrafts()
        }
        busy.current = true
        setSubmitting(true)
        let current
        function receive(value) {
          if (value.groupId && value.jobId) setPollRun(value => value + 1)
          if (value.projectCreated && current?.projectName) {
            const project = { id: current.projectId, name: current.projectName }
            setCatalog(previous => previous.projects.some(item => item.id === project.id) ? previous
              : { ...previous, projects: [...previous.projects, project] })
            setForm(previous => ({ ...previous, projectId: project.id }))
            rememberRecent(catalog?.scope, { projectId: project.id })
          }
          if (attempt.current?.repeatJobId && !value.jobId) {
            setRepeatStatus(value.status === 'unknown' ? 'generationUnknown'
              : submissionMessages.get(value.code) ?? 'failedToSubmit')
          } else {
            setResult(previous => {
              if (current?.candidateCount > 1 && previous?.groupId === current.operationId) {
                const acceptedCount = Math.max(previous.acceptedCount ?? 0, value.acceptedCount ?? 0)
                const complete = acceptedCount >= (value.requestedCount ?? previous.requestedCount)
                return { ...previous, ...value, projectId: current.projectId, acceptedCount,
                  ...(complete && { status: 'accepted', groupComplete: true, canContinueGroup: false }) }
              }
              return { ...value, projectId: current?.projectId,
                ...(value.status === 'unknown' && previous?.draftSaved
                  && { draftSaved: true, canvasUrl: value.canvasUrl ?? previous.canvasUrl }) }
            })
            setRepeatStatus(null)
          }
          if (value.status !== 'unknown' || value.groupComplete) {
            if (!value.groupId || value.groupComplete) forgetSubmission(current)
            attempt.current = null
          }
        }
        try {
          const check = attempt.current !== null
          attempt.current ??= makeAttempt()
          current = attempt.current
          if (!check) rememberSubmission(attempt.current, attempt.current.repeatJobId
            ? ['repeat', attempt.current.projectId, attempt.current.repeatJobId].join(':') : draftKey,
          form.prompt || existingJob?.prompt || '')
          const response = await fetch('/api/opendirector/creation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-OpenDirector-Action': '1' },
            body: JSON.stringify({ ...attempt.current, check }),
          })
          if (response.status === 400 || response.status === 403) {
            receive({ status: check ? 'unknown' : 'rejected' })
            return
          }
          if (!response.ok) throw new Error('Submission unavailable')
          receive(await response.json())
        } catch {
          receive({ status: attempt.current ? 'unknown' : 'rejected' })
        } finally {
          busy.current = false
          setSubmitting(false)
        }
      }
      function submit(event) {
        event.preventDefault()
        if (!unknown && (locked || missing)) return
        send(() => {
          const newProject = !source && !templateOf && form.projectId === 'new'
          return {
            projectId: templateOf?.projectId ?? source?.projectId ?? (newProject ? crypto.randomUUID() : form.projectId),
            operationId: crypto.randomUUID(),
            ...(templateOf && { reuseResultId: templateOf.resultId }),
            ...(videoMode ? { videoMode, sourceResultId: source.resultId, durationSeconds }
              : source && { sourceResultIds: references.map(item => item.resultId) }),
            ...(newProject && { projectName: form.projectName.trim() }),
            kind: form.kind, modelConfigId: form.modelId, prompt: form.prompt.trim(),
            output: templateOf ? form.output : output, voice: form.voice, candidateCount: form.candidateCount,
          }
        })
      }
      function field(label, control) {
        return h('label', { style: { display: 'grid', gap: '.3rem' } }, t(label), cloneElement(control, { 'aria-label': t(label) }))
      }
      const status = progress?.jobId === jobId ? progress?.status : null
      const candidates = progress?.results ?? []
      const providerUnknown = Boolean(status) && progress.category === 'submission_unknown'
      const canRetry = status === 'failed' && progress.canRetry
      const outcome = providerUnknown ? 'providerUnknown'
        : status === 'failed' ? generationMessages.get(progress.category) ?? 'failed'
          : ['cancelled', 'interrupted'].includes(status) ? 'stopped' : status === 'accepted' ? 'queued' : status
      const submitLabel = submitting ? 'submitting' : unknown ? 'checkGeneration'
        : result?.status === 'rejected' ? 'retrySubmission' : 'generate'
      const generateLabel = submitLabel === 'generate' && form.candidateCount > 1
        ? t('generateGroup').replace('{count}', form.candidateCount) : t(submitLabel)
      function toggleComparison(candidate) {
        setComparison(previous => previous.includes(candidate.resultId) ? previous.filter(id => id !== candidate.resultId)
          : previous.length < 2 ? [...previous, candidate.resultId] : previous)
      }
      function checkGroup() {
        attempt.current ??= { projectId, operationId: groupId, candidateCount: result.requestedCount }
        return send(() => ({}))
      }
      async function continueGroup() {
        const identity = { projectId, operationId: groupId, candidateCount: result.requestedCount }
        attempt.current = null
        await send(() => ({ ...identity, continueGroup: true }))
      }
      const sourcePreview = source && h(Preview, {
        version: source.version, projectId: source.projectId, assetId: source.assetId, kind: source.kind, details: source.details, t,
        title: t(continuation ? 'sourceClip' : videoMode ? 'firstFrameSource' : 'original'),
      })
      if (recoveredJob) return h(GenerationDialog, { existingJob: recoveredJob, t, onClose })
      if (packSource) return h(ActionPackDialog, { source: packSource, t, onClose: () => setPackSource(null) })
      return h('dialog', {
        className: 'od-media-ui',
        ref: dialog, onClose: event => { if (event.target === event.currentTarget) { flushMediaDrafts(); onClose() } },
        'aria-label': title, style: dialogStyle,
      },
        dialogHeader(title, () => dialog.current.close(), t,
          !existingJob && !source && !templateOf && !jobId ? t('createHint') : undefined),
        !existingJob && !restoringPending && !catalog && h('p', { role: 'status' }, t('loading')),
        !existingJob && !restoringPending && !locked && h('div', { style: row },
          restored && h('small', { role: 'status' }, t('draftRestored')),
          !restored && recentRestored && h('small', { role: 'status' }, t('recentRestored')),
          dirty && catalog && !catalog.error && button(t(templateOf ? 'resetTemplate' : 'clearDraft'), clearDraft)),
        projectUnavailable && h('p', { role: 'alert' }, t('projectUnavailable')),
        modelUnavailable && h('p', { role: 'alert' }, t('modelUnavailable')),
        existingJob && h('p', { style: { overflowWrap: 'anywhere' } }, existingJob.prompt),
        catalog?.error && h('div', { style: row },
          h('p', { role: 'alert' }, t(templateOf ? 'reuseUnavailable' : 'libraryError')),
          button(t('reloadData'), () => setCatalogRun(value => value + 1))),
        restoringPending && h(PendingSubmissions, { context: draftKey, t, onRecovered: setRecoveredJob }),
        restoringPending && !existingJob && button(t('startSeparateCreation'), () => setStartFresh(true)),
        !restoringPending && pending.length > 0 && !pendingDurable && h('p', { role: 'alert' }, t('pendingStorageUnavailable')),
        !restoringPending && catalog && !catalog.error && h(jobId ? 'details' : 'div',
          { className: jobId ? 'od-settings' : undefined },
          jobId && h('summary', null, t('generationSettings')),
          h('form', { onSubmit: submit, className: 'od-create-form' },
          field(form.kind === 'audio' ? 'speechText' : continuation ? 'shot' : videoMode ? 'motion' : source ? 'brief' : 'prompt', h('textarea', {
            required: true, disabled: locked, rows: 3, maxLength: Math.min(model?.maxPromptCharacters ?? 20000, 20000),
            placeholder: !source && form.kind === 'image' ? t('promptPlaceholder') : undefined,
            value: form.prompt, onChange: event => update('prompt', event.target.value),
          })),
          !locked && h(ExamplePicker, {
            key: form.kind + (videoMode ?? ''), mode: form.kind === 'audio' ? 'audio' : continuation ? 'continuation' : videoMode ? 'first_frame' : source ? 'edit' : 'image',
            prompt: form.prompt, t, onApply: value => update('prompt', value),
          }),
          h('div', { className: 'od-create-options' },
          !source && !templateOf && field('chooseProject', h('select', {
            required: true, disabled: locked, value: form.projectId, onChange: event => update('projectId', event.target.value),
          }, h('option', { value: '' }, t('chooseProject')),
          ...catalog.projects.map(({ id, name }) => h('option', { key: id, value: id }, name)),
          h('option', { value: 'new' }, t('newProject')))),
          !source && !templateOf && form.projectId === 'new' && field('projectName', h('input', {
            required: true, disabled: locked, value: form.projectName, onChange: event => update('projectName', event.target.value),
          })),
          !source && !templateOf && field('mediaType', h('select', {
            disabled: locked, value: form.kind, onChange: event => update('kind', event.target.value),
          }, h('option', { value: 'image' }, t('picture')), h('option', { value: 'audio' }, t('speech')))),
          field('model', h('select', {
            name: 'model', required: true, disabled: locked || Boolean(templateOf), value: form.modelId, onChange: event => update('modelId', event.target.value),
          }, h('option', { value: '' }, t('chooseModel')),
          ...choices.map(item => h('option', { key: item.id, value: item.id },
            `${item.modelId} · ${t(item.connectionType === 'self_hosted' ? 'local' : 'hosted')}`)))),
          choices.length === 0 && h('div', { style: row }, h('p', null, t('noModels')),
            !locked && button(t('reloadData'), () => setCatalogRun(value => value + 1))),
          video?.durations.length > 0 && field('videoDuration', h('select', {
            disabled: locked, value: durationUnavailable ? '' : durationSeconds,
            onChange: event => update('durationSeconds', Number(event.target.value)),
          }, durationUnavailable && h('option', { value: '', disabled: true }, t('chooseDuration')),
          ...video.durations.map(seconds => h('option', { key: seconds, value: seconds },
            t('duration').replace('{seconds}', seconds))))),
          video?.durations.length === 0 && h('small', null, t('modelDuration')),
          durationUnavailable && h('p', { role: 'alert' }, t('durationUnavailable')),
          durationUnavailable && video.durations.length === 0
            && button(t('useDefaultDuration'), () => update('durationSeconds', null), { disabled: locked }),
          form.kind === 'image' && h(ImageOutputField, { selection: imageSize,
            original: templateOf ? catalog.template.originalOutput ?? '' : undefined,
            onChange: value => update('output', value), disabled: locked, t }),
          form.kind === 'audio' && field('voice', h('input', {
            required: model?.voiceRequired, disabled: locked || Boolean(templateOf), maxLength: 200, value: form.voice,
            onChange: event => update('voice', event.target.value),
          })),
          field('candidateCount', h('select', { value: form.candidateCount, disabled: locked,
            onChange: event => update('candidateCount', Number(event.target.value)) },
            ...[1, 2, 3, 4].map(count => h('option', { key: count, value: count }, count)))),
          form.candidateCount > 1 && h('small', null, t('groupHint').replace('{count}', form.candidateCount))),
          catalog.template && h('small', null, t('reuseHint')),
          catalog.template?.references.length > 0 && h('section', { 'aria-label': t('reuseReferences') },
            h('small', null, t('reuseReferences')),
            h('div', { style: { display: 'grid', gap: '.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(10rem, 100%), 1fr))' } },
              ...catalog.template.references.map((reference, index) => h(Preview, { ...reference,
                key: index, projectId: templateOf.projectId, t, title: t('referenceMedia') + ' ' + (index + 1),
              })))),
          candidates.length === 0 && sourcePreview,
          continuation && h('small', null, t('continuationHint')),
          source && !videoMode && h(ReferencePicker, { projectId: source.projectId, references, setReferences, limit: referenceLimit, locked, t }),
          tooManyReferences && h('p', { role: 'alert' }, t('referencesChanged')),
          (!locked || submitting || unknown) && h(SubmitRow, { label: generateLabel, busy: submitting,
            reason: !unknown && missing ? t(missing) : null, focusModel: !unknown && missing === 'needsModel' }))),
        templateOf?.canvasUrl && catalog?.error && canvasLink(templateOf.canvasUrl, t),
        result?.status === 'rejected' && h('p', { role: 'alert' }, t(submissionMessages.get(result.code) ?? 'failedToSubmit')),
        unknown && h('p', { role: 'status' }, t('generationUnknown')),
        result?.draftSaved && !jobId && h('p', null, t('draftSaved')),
        jobId && h('p', { role: status === 'failed' || providerUnknown ? 'alert' : 'status' }, t(outcome ?? 'waiting')),
        jobId && h('small', null, t('backgroundHint')),
        groupId && progress?.jobs && h('section', { 'aria-label': t('candidateCount'), style: { display: 'grid', gap: '.4rem' } },
          h('strong', null, t('groupSummary').replace('{done}', progress.completedCount)
            .replace('{total}', progress.totalCount).replace('{failed}', progress.failedCount)),
          ...progress.jobs.map((job, index) => h('div', { key: job.jobId, style: row },
            h('span', null, t('groupTask').replace('{number}', index + 1) + ' · ' + t(
              ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status) ? job.status : 'waiting')),
            job.category && h('small', null, t(generationMessages.get(job.category) ?? 'failed')),
            h(JobCancellation, { projectId, jobId: job.jobId, progress: job, t,
              onChange: () => setPollRun(value => value + 1) })))),
        groupId && result.requestedCount > result.acceptedCount && h('div', null,
          h('p', { role: 'status' }, result.groupComplete ? t('groupStopped')
            : t('groupUnsubmitted').replace('{count}', result.requestedCount - result.acceptedCount)),
          !result.groupComplete && button(t('checkGeneration'), checkGroup, { disabled: submitting }),
          result.canContinueGroup && button(t('continueGroup'), continueGroup, { disabled: submitting })),
        jobId && !groupId && h(JobCancellation, { key: jobId, projectId, jobId, progress: progress?.jobId === jobId ? progress : null, t,
          onChange: () => setPollRun(value => value + 1) }),
        continuation && status === 'failed' && progress.category === 'reference' && h('p', null, t('continuationUnavailable')),
        status && progress.canResume && h('p', null, t('recoverOnCanvas')),
        updatesPaused && ['accepted', 'queued', 'running'].includes(progress?.status ?? result?.status ?? existingJob?.status)
          && h('small', { role: 'status' }, t('updatesPaused')),
        pollError && h('p', { role: 'alert' }, t('progressUnavailable')),
        (pollError || providerUnknown) && button(t('checkProgress'), () => { setPollError(false); setPollRun(value => value + 1) }),
        result?.canvasUrl && (jobId || result.draftSaved) && canvasLink(result.canvasUrl, t),
        candidates.length > 0 && h('div', {
          style: { display: 'grid', gap: '.7rem', marginBlock: '.7rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(12rem, 100%), 1fr))' },
        }, sourcePreview, ...candidates.map((candidate, index) => h(Preview, {
          ...candidate, projectId, key: candidate.resultId, t, canvasUrl: result.canvasUrl,
          onMakePack: () => { packTrigger.current = candidate.resultId; setPackSource({ ...candidate, projectId }) },
          title: candidate.version || candidates.length === 1 ? t('candidate') : `${t('candidate')} ${index + 1}`,
          onCompare: groupId && candidate.kind === 'image' ? () => toggleComparison(candidate) : undefined,
          compareSelected: comparison.includes(candidate.resultId),
          compareDisabled: comparison.length === 2 && !comparison.includes(candidate.resultId),
          onAdopted: () => setProgress(previous => ({ ...previous,
            results: previous.results.map(item => ({ ...item, selected: item.resultId === candidate.resultId })),
          })),
        }))),
        groupId && candidates.some(candidate => candidate.kind === 'image') && button(t('groupCompare') + ' (' + comparison.length + '/2)',
          () => setComparing(true), { disabled: comparison.length !== 2 }),
        comparing && h(ImageComparisonDialog, { projectId, resultIds: comparison, t,
          onAdopted: () => setPollRun(value => value + 1), onClose: () => setComparing(false) }),
        !restoringPending && !groupId && ((status === 'succeeded' && candidates.length > 0) || canRetry) && h('div', { style: row },
          h('label', { style: row }, t('moreCandidateCount'), h('select', { value: repeatCount,
            'aria-label': t('moreCandidateCount'), disabled: submitting,
            onChange: event => setRepeatCount(Number(event.target.value)) },
            ...[1, 2, 3, 4].map(count => h('option', { key: count, value: count }, count)))),
          button(repeatCount > 1 && !submitting && repeatStatus !== 'generationUnknown'
            ? t('generateGroup').replace('{count}', repeatCount)
            : t(submitting ? 'submitting' : repeatStatus === 'generationUnknown' ? 'checkGeneration'
            : canRetry ? 'retryGeneration' : 'repeatGeneration'),
            () => send(() => ({ projectId, operationId: crypto.randomUUID(), repeatJobId: jobId, candidateCount: repeatCount })), { disabled: submitting }),
          h('small', { style: { color: muted } }, t('repeatHint'))),
        repeatStatus && h('p', { role: repeatStatus === 'generationUnknown' ? 'status' : 'alert' }, t(repeatStatus)))
    }

    function JobCancellation({ projectId, jobId, progress, t, onChange }) {
      const operation = useRef(null)
      const busy = useRef(false)
      const [state, setState] = useState(null)
      const requested = progress?.cancelRequested || state === 'stopRequested'
      const active = ['accepted', 'queued', 'running'].includes(progress?.status)
      const unknown = state === 'stopUnknown'
      async function stop() {
        if (busy.current) return
        busy.current = true
        const check = operation.current !== null
        operation.current ??= crypto.randomUUID()
        setState('stoppingGeneration')
        try {
          const response = await fetch('/api/opendirector/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-OpenDirector-Action': '1' },
            body: JSON.stringify({ projectId, jobId, operationId: operation.current, check }),
          })
          if (response.status === 400 || response.status === 403) {
            operation.current = null
            setState('stopFailed')
            return
          }
          if (!response.ok) throw new Error('Stop response unavailable')
          const receipt = await response.json()
          if (receipt.status === 'unknown') {
            setState('stopUnknown')
            return
          }
          operation.current = null
          setState(receipt.status === 'applied' ? 'stopRequested' : receipt.status === 'noop' ? 'stopFinished'
            : receipt.code === 'storage_busy' ? 'adoptBusy'
              : receipt.code === 'revision_conflict' ? 'stopChanged' : 'stopFailed')
          onChange()
        } catch {
          setState('stopUnknown')
        } finally {
          busy.current = false
        }
      }
      let message = state
      if (progress?.cancelRequested) {
        message = progress.status === 'succeeded' ? 'stopFinished'
          : progress.status === 'cancelled'
            ? progress.remoteCancellation === 'confirmed' ? 'remoteStopped'
              : ['requested', 'unknown'].includes(progress.remoteCancellation) ? 'remoteStopUnconfirmed' : 'localStopped'
            : 'stopRequested'
      }
      if (!active && !message) return null
      return h('div', { style: { display: 'grid', gap: '.4rem' } },
        ((active && !requested) || unknown) && button(t(state === 'stoppingGeneration' ? state : unknown ? 'checkStop' : 'stopGeneration'),
          stop, { disabled: state === 'stoppingGeneration' }),
        message === 'remoteStopUnconfirmed' && button(t('checkProgress'), onChange),
        message && h('p', { role: ['stopFailed', 'stopUnknown', 'stopChanged', 'adoptBusy', 'remoteStopUnconfirmed'].includes(message) ? 'alert' : 'status' }, t(message)))
    }

    function useAdoption({ projectId, resultId, onAdopted }) {
      const operation = useRef(null)
      const running = useRef(false)
      const [status, setStatus] = useState(null)
      const [canvasUrl, setCanvasUrl] = useState(null)
      async function adopt() {
        if (running.current) return
        running.current = true
        const check = operation.current !== null
        setStatus('adopting')
        try {
          operation.current ??= crypto.randomUUID()
          const response = await fetch('/api/opendirector/adopt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-OpenDirector-Action': '1' },
            body: JSON.stringify({ projectId, resultId, operationId: operation.current, check }),
          })
          if (response.status === 400 || response.status === 403) {
            operation.current = null
            setStatus('adoptFailed')
            return
          }
          if (!response.ok) throw new Error('Adoption response unavailable')
          const { status: outcome, code, canvasUrl: url } = await response.json()
          if (outcome === 'unknown') {
            setStatus('adoptUnknown')
            return
          }
          operation.current = null
          if (outcome === 'applied' || outcome === 'noop') {
            setStatus('adopted')
            setCanvasUrl(url)
            onAdopted?.()
          } else {
            setStatus(code === 'storage_busy' ? 'adoptBusy'
              : ['revision_conflict', 'missing_object', 'result.candidate_missing'].includes(code) ? 'adoptConflict'
                : 'adoptFailed')
          }
        } catch {
          setStatus(operation.current ? 'adoptUnknown' : 'adoptFailed')
        } finally {
          running.current = false
        }
      }
      return { adopt, status, canvasUrl }
    }

    function ActionMenu({ actions, position, trigger, close, label, t }) {
      const menu = useRef(null)
      useLayoutEffect(() => {
        const element = menu.current
        element.style.left = '0px'
        element.style.top = '0px'
        const origin = element.getBoundingClientRect()
        element.style.left = '100px'
        element.style.top = '100px'
        const shifted = element.getBoundingClientRect()
        const scaleX = (shifted.left - origin.left) / 100 || 1
        const scaleY = (shifted.top - origin.top) / 100 || 1
        const left = Math.max(8, Math.min(position.x, window.innerWidth - origin.width - 8))
        const anchorY = position.above ? position.y - origin.height - 4 : position.y
        const top = Math.max(8, Math.min(anchorY, window.innerHeight - origin.height - 8))
        // Measure CSS offsets in viewport coordinates to include host zoom without integer-size rounding.
        element.style.left = `${(left - origin.left) / scaleX}px`
        element.style.top = `${(top - origin.top) / scaleY}px`
        element.querySelector('[role="menuitem"]')?.focus()
      }, [position])
      useEffect(() => {
        function outside(event) {
          if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false)
        }
        document.addEventListener('pointerdown', outside)
        return () => document.removeEventListener('pointerdown', outside)
      }, [close, trigger])
      function keyboard(event) {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.stopPropagation()
          if (event.key === 'Escape') event.preventDefault()
          close()
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = [...menu.current.querySelectorAll('[role="menuitem"]')]
        const current = items.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }
      const style = { ...buttonStyle, display: 'block', width: '100%', textAlign: 'start', whiteSpace: 'nowrap',
        border: 0, textDecoration: 'none', boxSizing: 'border-box' }
      return h('div', {
        ref: menu, role: 'menu', 'aria-label': label, onKeyDown: keyboard,
        style: { position: 'fixed', zIndex: 100, padding: '.25rem', border, borderRadius: '.45rem',
          background: surface, boxShadow: '0 4px 16px #0004', maxHeight: 'calc(100vh - 16px)', overflow: 'auto' },
      }, ...actions.map(({ label, run, href, quick, ...attributes }) => h(href ? 'a' : 'button', {
        key: label, role: 'menuitem', tabIndex: -1, style,
        ...(href ? { href } : { type: 'button' }), ...attributes,
        onClick: () => { close(); run?.() },
      }, t(label))))
    }

    function OriginalImageDialog({ url, title, t, onClose }) {
      const dialog = useRef(null)
      const [actualSize, setActualSize] = useState(false)
      const [status, setStatus] = useState('loading')
      useEffect(() => { dialog.current.showModal() }, [])
      return h('dialog', {
        className: 'od-media-ui',
        ref: dialog, 'aria-label': t('viewOriginal'),
        onClose: event => { if (event.target === event.currentTarget) onClose() },
        onContextMenu: event => event.stopPropagation(),
        style: { ...dialogStyle, width: 'min(72rem, calc(100vw - 2rem))' },
      },
        h('header', { style: { ...row, justifyContent: 'space-between', marginBottom: '.65rem' } },
          h('strong', null, title),
          h('div', { style: row },
            button(t(actualSize ? 'fitImage' : 'actualImageSize'), () => setActualSize(value => !value),
              { disabled: status !== 'ready' }),
            button(t('close'), () => dialog.current.close(), { autoFocus: true }))),
        status === 'loading' && h('p', { role: 'status' }, t('loading')),
        status === 'failed' ? h('div', { style: row },
          h('span', { role: 'alert' }, t('originalUnavailable')),
          button(t('reloadData'), () => setStatus('loading')))
          : h('div', { style: { maxHeight: '62vh', overflow: 'auto', background: surface, borderRadius: '.55rem' } },
            h('img', {
              src: url, alt: title, onLoad: () => setStatus('ready'), onError: () => setStatus('failed'),
              style: { display: 'block', margin: 'auto', maxWidth: actualSize ? 'none' : '100%',
                maxHeight: actualSize ? 'none' : '62vh', width: 'auto', height: 'auto' },
            })))
    }

    function Preview({ projectId, assetId, resultId, kind, title, selected, prompt, details, t, onAdopted, onMakePack, canvasUrl, expanded, onCompare, compareSelected, compareDisabled, compactActions, version, createdAt, sourceResultId, sourceVersion, sourceTitle }) {
      const [failed, setFailed] = useState(false)
      const [action, setAction] = useState(null)
      const [status, setStatus] = useState('')
      const [viewingOriginal, setViewingOriginal] = useState(false)
      const [menu, setMenu] = useState(null)
      const [buffering, setBuffering] = useState(false)
      const trigger = useRef(null)
      const player = useRef(null)
      const adoption = useAdoption({ projectId, resultId, onAdopted })
      const thumbnailUrl = mediaHref(projectId, assetId, kind)
      const downloadUrl = thumbnailUrl + '&original=1'
      const url = expanded && kind === 'image' ? downloadUrl : thumbnailUrl
      const video = kind === 'video'
      const audio = kind === 'audio'
      const image = kind === 'image'
      const facts = [
        (image || video) && details?.width && details?.height && t('fileSize').replace('{size}', `${details.width} × ${details.height}`),
        image && details?.requestedSize && t('requestedSize').replace('{size}', details.requestedSize.replace('x', ' × ')),
        (video || audio) && details?.durationSeconds
          && t('duration').replace('{seconds}', Number(details.durationSeconds.toFixed(2))),
      ].filter(Boolean)
      const versionText = Number.isInteger(version) && version > 0 ? t('versionLabel').replace('{number}', version) : ''
      const created = typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt) : null
      const sourceText = sourceResultId && Number.isInteger(sourceVersion) && sourceVersion > 0
        ? t('sourceVersionLabel').replace('{title}', sourceTitle || t('candidate')).replace('{number}', sourceVersion) : ''
      const mediaStyle = { width: '100%', height: expanded ? 'clamp(14rem, 50vh, 36rem)' : 'var(--od-preview-height)', display: 'block', objectFit: 'contain',
        borderRadius: '.55rem', background: surface }
      const onError = () => { setBuffering(false); setFailed(true) }
      const playbackEvents = {
        onWaiting: () => setBuffering(true), onStalled: () => setBuffering(true),
        onPlaying: () => setBuffering(false), onCanPlay: () => setBuffering(false),
        onPause: () => setBuffering(false), onEnded: () => setBuffering(false),
      }
      const media = video
        ? h('video', { ...playbackEvents, ref: player, src: url, controls: true, playsInline: true, preload: 'none', 'aria-label': title, onError, style: mediaStyle })
        : audio ? h('audio', { ...playbackEvents, ref: player, src: url, controls: true, preload: 'none', 'aria-label': title, onError, style: { width: '100%' } })
          : h('button', { type: 'button', onClick: () => setViewingOriginal(true),
            'aria-label': t('viewOriginal'), 'aria-haspopup': 'dialog', title: t('viewOriginal'),
            style: { padding: 0, border: 0, background: 'transparent', cursor: 'zoom-in' },
          }, h('img', { src: url, alt: title, loading: 'lazy', onError, style: mediaStyle }))
      async function copyResult() {
        try {
          await navigator.clipboard.writeText(resultId)
          setStatus(t('copied'))
        } catch {
          setStatus(resultId)
        }
      }
      function closeMenu(restore = true) {
        setMenu(null)
        if (restore) trigger.current?.focus()
      }
      function contextMenu(event) {
        if (event.target.closest('audio, video, form, [role="menu"]')) return
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }
      function togglePlayback() {
        const element = player.current
        if (!element) return
        if (element.paused) element.play().catch(() => setStatus(t('playbackFailed')))
        else element.pause()
      }
      const pending = adoption.status === 'adopting'
      const adoptLabel = pending ? 'adopting' : selected ? 'selected'
        : adoption.status === 'adoptUnknown' ? 'checkAdoption' : 'adopt'
      const actions = [
        !expanded && (image || audio) && { label: 'reuseSettings', quick: audio && !compactActions, run: () => setAction('reuse') },
        !expanded && image && { label: 'edit', quick: !compactActions, run: () => setAction('edit') },
        image && { label: 'newActionPack', run: onMakePack ?? (() => setAction('pack')) },
        image && { label: 'viewOriginal', run: () => setViewingOriginal(true) },
        !expanded && image && { label: 'firstFrame', run: () => setAction('first_frame') },
        video && { label: 'continue', quick: !compactActions, run: () => setAction('continuation') },
        (video || audio) && !failed && { label: player.current?.paused === false ? 'pause' : 'play', run: togglePlayback },
        !selected && !pending && { label: adoptLabel, run: adoption.adopt },
        { label: 'download', href: downloadUrl, download: '' },
        canvasUrl && { label: 'canvas', href: canvasUrl, target: '_blank', rel: 'noopener noreferrer' },
        { label: 'copyId', run: copyResult },
      ].filter(Boolean)
      const quickAction = actions.find(action => action.quick)
      return h('figure', {
        className: 'od-media-ui od-preview', 'data-selected': selected || undefined,
        'data-opendirector-result': resultId,
        onContextMenu: resultId ? contextMenu : undefined,
        style: { margin: 0, minWidth: 0, display: 'grid', gap: '.45rem', alignContent: 'start' },
      },
        h('figcaption', { style: { ...row, color: muted, fontSize: '.8em' } },
          h('strong', null, selected && title === t('candidate') ? t('selected') : title),
          versionText && h('span', { className: 'od-version', 'data-opendirector-version': version, 'data-current': selected || undefined }, versionText),
          facts.length > 0 && h('span', null, facts.join(' · '))),
        (created || sourceText) && h('div', { style: { ...row, color: muted, fontSize: '.73em' } },
          created && h('time', { dateTime: createdAt, title: created.toLocaleString() },
            created.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          sourceText && h('span', { 'data-opendirector-source-version': sourceVersion }, sourceText)),
        failed ? h('div', { style: row }, h('span', { role: 'alert' }, t('unavailable')),
          button(t('retryMedia'), () => {
            setFailed(false)
            setStatus(previous => previous === t('playbackFailed') ? '' : previous)
          }),
          image && button(t('viewOriginal'), () => setViewingOriginal(true), { 'aria-haspopup': 'dialog' })) : media,
        buffering && h('small', { role: 'status' }, t('buffering')),
        onCompare && h('label', { style: row },
          h('input', { type: 'checkbox', checked: compareSelected, disabled: compareDisabled,
            onChange: onCompare }), t('chooseComparison')),
        prompt && h('p', { style: { margin: 0, color: muted, fontSize: '.82em', overflowWrap: 'anywhere' } }, prompt),
        resultId && h('div', { style: { display: 'grid', gap: '.45rem' } },
          h('div', { style: row },
            button(t(adoptLabel), adoption.adopt, { primary: !selected, current: selected, symbol: selected ? 'check' : undefined, disabled: pending || selected }),
            quickAction && button(t(quickAction.label), quickAction.run, { 'aria-haspopup': 'dialog' }),
            button('···', event => {
              if (menu) closeMenu()
              else {
                const { left, bottom } = event.currentTarget.getBoundingClientRect()
                setMenu({ x: left, y: bottom })
              }
            }, { ref: trigger, 'aria-haspopup': 'menu', 'aria-expanded': Boolean(menu), title: t('actions'), 'aria-label': t('actions') })),
          menu && h(ActionMenu, { actions, position: menu, trigger, close: closeMenu, label: t('actions'), t }),
          adoption.status && !pending && !selected && !(adoption.status === 'adopted' && onAdopted)
            && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, t(adoption.status)),
          adoption.canvasUrl && !onAdopted && canvasLink(adoption.canvasUrl, t),
          status && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, status)),
        action === 'pack' && h(ActionPackDialog, { source: { projectId, resultId, assetId, kind, details, version }, t, onClose: () => setAction(null) }),
        action && action !== 'pack' && h(GenerationDialog, {
          source: action === 'reuse' ? undefined : { projectId, assetId, resultId, kind, details, version },
          templateOf: action === 'reuse' ? { projectId, resultId, kind, canvasUrl } : undefined,
          videoMode: ['edit', 'reuse'].includes(action) ? undefined : action,
          t, onClose: () => setAction(null),
        }),
        viewingOriginal && h(OriginalImageDialog, {
          url: downloadUrl, title, t, onClose: () => setViewingOriginal(false),
        }))
    }

    function canvasLink(url, t) {
      return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
        className: 'od-button', style: { ...buttonStyle, textDecoration: 'none', whiteSpace: 'nowrap' } }, `${t('canvas')} ↗`)
    }

    function MediaResults({ meta, t }) {
      const preview = meta.mediaPreview ?? meta.imagePreview
      const kind = preview.kind ?? 'image'
      const heading = t(kind === 'video' ? 'videos' : kind === 'audio' ? 'audios' : 'images')
      const sourceKind = preview.sourceKind ?? kind
      return h('section', { className: 'od-media-ui', 'aria-label': heading, [`data-opendirector-${kind}-results`]: '',
        style: { display: 'grid', gap: '.75rem', padding: '.85rem 1rem', border, borderRadius: '.9rem' } },
        h('header', { style: { ...row, justifyContent: 'space-between' } },
          h('div', { style: { display: 'grid', gap: '.1rem' } },
            h('span', { style: { color: muted, fontSize: '.73em' } }, `OpenDirector · ${heading}`),
            h('strong', { style: { fontSize: '1em', overflowWrap: 'anywhere' } }, preview.projectName)),
          canvasLink(meta.canvasUrl, t)),
        h('div', { style: { display: 'grid', gap: '.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(12rem, 100%), 1fr))' } },
          preview.sourceAssetId && h(Preview, {
            key: preview.sourceAssetId, projectId: meta.projectId, assetId: preview.sourceAssetId,
            version: preview.candidates[0]?.sourceVersion, kind: sourceKind, details: preview.sourceDetails, title: t(sourceKind === 'video' ? 'sourceClip' : 'original'), t,
          }),
          ...preview.candidates.map((candidate, index) => h(Preview, {
            ...candidate, key: candidate.resultId, projectId: meta.projectId, kind, t, canvasUrl: meta.canvasUrl,
            title: candidate.version ? t('candidate') : preview.candidates.length > 1 ? `${t('candidate')} ${index + 1}` : t('candidate'),
          }))))
    }

    function MediaResultsTail({ turn, useChat, t }) {
      const source = useChat(snapshot => snapshot.nodes.turnDataSource(turn.turn, 'tool-call'))
      const calls = useSyncExternalStore(source.subscribe, source.getSnapshot)
      const previews = new Map()
      const adoptions = new Map()
      for (const { root } of calls) {
        const meta = root.meta
        if (root.name === 'opendirector_job' && (meta?.mediaPreview || meta?.imagePreview)) {
          previews.set(meta.jobId, meta)
        } else if (root.name === 'opendirector_adopt_result' && meta?.status === 'applied' && meta.canvasUrl) {
          adoptions.set(meta.resultId, meta.canvasUrl)
        }
      }
      if (!previews.size && !adoptions.size) return null
      return h('div', { className: 'od-media-ui', style: { display: 'grid', gap: '.65rem' } },
        ...Array.from(previews, ([key, meta]) => h(MediaResults, { key, meta, t })),
        ...Array.from(adoptions, ([key, url]) => h('div', {
          key, 'data-opendirector-adoption': '', style: { ...row, justifyContent: 'space-between',
            padding: '.5rem .7rem', border, borderRadius: '.55rem', fontSize: '.9em' },
        }, h('strong', null, t('adopted')), canvasLink(url, t))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = clientStyles + packStyles
          document.head.append(style)
          return () => style.remove()
        })
        ctx.effect(() => {
          window.addEventListener('pagehide', flushMediaDrafts)
          return () => { flushMediaDrafts(); window.removeEventListener('pagehide', flushMediaDrafts) }
        })
        ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: '@opendirector/dsh-plugin', locale: namespace,
        }, MediaResultsTail))
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: '@opendirector/dsh-plugin:create', locale: namespace,
        }, props => h(CreateMedia, { ...props,
          openPlugin: typeof ctx.get('pluginNavigation')?.openBundle === 'function'
            ? () => ctx.get('pluginNavigation')?.openBundle('@opendirector/dsh-plugin') : undefined,
        })))
      },
    }
  },
})
