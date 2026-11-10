/* DSH loads client exports through its browser module loader. React comes from the host. */
window.__ModuleLoader__.load({
  id: '@opendirector/dsh-plugin',
  factory(require) {
    const { cloneElement, createElement: h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = require('react')
    const namespace = 'opendirector'
    const en = {
      images: 'Image results', videos: 'Video results', original: 'Original', sourceClip: 'Source clip',
      candidate: 'Candidate', unavailable: 'Preview unavailable. Open the canvas to view this result.',
      canvas: 'Open canvas', edit: 'Edit', firstFrame: 'Animate', continue: 'Continue', adopt: 'Adopt', adopted: 'Result adopted',
      create: 'Create media', send: 'Send request', cancel: 'Cancel',
      draftBusy: 'Finish or clear your current draft first.', brief: 'Describe what to change',
      shot: 'Describe the next shot', ready: 'Request sent.', copyId: 'Copy result ID', copied: 'Result ID copied.',
      firstFramePrompt: 'Use the image as the first frame of a video. Show the candidate before adopting it.',
      continuePrompt: 'Continue the clip with a compatible video model. Show the candidate before adopting it.',
      resume: 'Resume project', close: 'Close', chooseProject: 'Choose a project',
      projectsEmpty: 'No OpenDirector projects yet.', resultsEmpty: 'This project has no saved media results.',
      loading: 'Loading…', refresh: 'Refresh results', libraryError: 'Could not load OpenDirector. Try refreshing.',
      recent: 'Saved results', selected: 'Current result', adopting: 'Adopting…', checkAdoption: 'Check adoption',
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
      noModels: 'Configure a compatible model in OpenDirector first.',
      failedToSubmit: 'Could not submit generation. Check your project and model settings.',
      generationUnknown: 'Submission has not been confirmed. Check the original operation.',
      draftSaved: 'The generation settings are saved on the canvas.',
      waiting: 'Waiting for OpenDirector…', queued: 'Queued', running: 'Generating…',
      succeeded: 'Candidate ready', stopped: 'Generation stopped', failed: 'Generation failed',
      quota: 'The model service reported a quota error. Check the provider before trying again.',
      checkProgress: 'Check progress', download: 'Download original',
      libraryType: 'Filter by media', librarySelection: 'Filter by selection', libraryOrder: 'Sort results',
      allMedia: 'All media', video: 'Video', audio: 'Audio', allSelections: 'All results', other: 'Other results',
      newest: 'Newest first', oldest: 'Oldest first', loadMore: 'Load more', noMatches: 'No results match these filters.',
      actions: 'More actions', play: 'Play', pause: 'Pause', playbackFailed: 'Could not start playback.',
      references: 'Reference images', chooseReferences: 'Add reference images', hideReferences: 'Hide image picker',
      addReference: 'Add reference', removeReference: 'Remove reference', referenceImage: 'Reference image',
      noMoreImages: 'No other saved images on this page.',
      referenceOrder: 'The source comes first, followed by images in the order you add them.',
      referenceLimit: 'This model accepts up to {count} reference images.',
      referencesChanged: 'Check the selected images and the model’s reference limit, then try again.',
      reference: 'OpenDirector project and result',
    }
    const zh = {
      images: '图片结果', videos: '视频结果', original: '原图', sourceClip: '源片段',
      candidate: '候选', unavailable: '暂时无法预览。可在画布查看。',
      canvas: '打开画布', edit: '改图', firstFrame: '转成视频', continue: '续写', adopt: '采用', adopted: '已采用结果',
      create: '创作素材', send: '发送请求', cancel: '取消',
      draftBusy: '请先发送或清空当前草稿。', brief: '描述你想改什么',
      shot: '描述接下来的镜头', ready: '请求已发送。', copyId: '复制结果 ID', copied: '已复制结果 ID。',
      firstFramePrompt: '用这张图片作为视频首帧，先展示候选，再由我决定是否采用。',
      continuePrompt: '用支持续写的模型接着生成这段视频，先展示候选，再由我决定是否采用。',
      resume: '继续工程', close: '关闭', chooseProject: '选择工程',
      projectsEmpty: '还没有 OpenDirector 工程。', resultsEmpty: '这个工程还没有保存素材结果。',
      loading: '加载中…', refresh: '刷新结果', libraryError: '暂时无法读取 OpenDirector，请刷新重试。',
      recent: '已保存的结果', selected: '当前结果', adopting: '正在采用…', checkAdoption: '查询采用状态',
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
      noModels: '请先在 OpenDirector 配置支持此操作的模型。',
      failedToSubmit: '暂时无法提交生成，请检查工程和模型设置。',
      generationUnknown: '尚未确认任务是否提交，请查询原操作。',
      draftSaved: '本次生成配置已保存到画布。',
      waiting: '等待 OpenDirector…', queued: '排队中', running: '生成中…',
      succeeded: '候选已生成', stopped: '生成已停止', failed: '生成失败',
      quota: '模型服务返回额度错误，请检查服务商后再试。',
      checkProgress: '查询进度', download: '下载原文件',
      libraryType: '按素材类型筛选', librarySelection: '按采用状态筛选', libraryOrder: '排序',
      allMedia: '全部素材', video: '视频', audio: '音频', allSelections: '全部结果', other: '其他结果',
      newest: '最新优先', oldest: '最早优先', loadMore: '加载更多', noMatches: '没有符合筛选条件的结果。',
      actions: '更多操作', play: '播放', pause: '暂停', playbackFailed: '暂时无法播放。',
      references: '参考图', chooseReferences: '添加参考图', hideReferences: '收起选图',
      addReference: '加入参考图', removeReference: '移除参考图', referenceImage: '参考图',
      noMoreImages: '这一页没有其他已保存的图片。',
      referenceOrder: '原图排在第一张，其他图片按加入顺序排列。',
      referenceLimit: '当前模型最多支持 {count} 张参考图。',
      referencesChanged: '请核对所选图片和模型的参考图上限，再试一次。',
      reference: 'OpenDirector 工程与结果',
    }

    const border = '1px solid var(--dsw-alias-border-l1)'
    const muted = 'var(--dsw-alias-label-secondary)'
    const surface = 'var(--dsw-alias-markdown-code-block)'
    const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.4rem' }
    const buttonStyle = {
      font: 'inherit', fontSize: '.82em', padding: '.3rem .65rem', borderRadius: '.45rem',
      border, background: 'transparent', color: 'inherit', cursor: 'pointer',
    }
    const dialogStyle = { width: 'min(46rem, calc(100vw - 2rem))', maxHeight: '80vh', boxSizing: 'border-box',
      color: 'inherit', background: surface, border, borderRadius: '.85rem', padding: '1rem' }
    const libraryDefaults = { kind: 'all', selection: 'all', order: 'newest' }

    function button(label, onClick, options = {}) {
      const { primary, ...attrs } = options
      return h('button', {
        type: 'button', onClick, ...attrs,
        style: { ...buttonStyle, ...(primary && { background: surface, fontWeight: 600 }) },
      }, label)
    }

    function mediaHref(project, asset, kind) {
      return '/api/opendirector/media?' + new URLSearchParams({ project, asset, kind })
    }

    function useComposerRequest(useInput, inputActions) {
      const emptyRevision = useInput(state => state.phase === 'plain' && !state.draft.trim()
        && !state.attachmentIds.length && !state.occurrences.length ? state.draftRev : null)
      return (text, send = false) => {
        if (emptyRevision === null) return false
        const span = inputActions.captureInsertion()
        if (span.draftRev !== emptyRevision || !inputActions.insertText(text, span)) return false
        if (send) inputActions.submit()
        return true
      }
    }

    function CreateMedia({ t, useInput, inputActions }) {
      const request = useComposerRequest(useInput, inputActions)
      const [open, setOpen] = useState(null)
      return h('div', { style: row },
        button(t('create'), () => setOpen('creation'), { title: 'OpenDirector', 'aria-haspopup': 'dialog' }),
        button(t('resume'), () => setOpen('library'), { 'aria-haspopup': 'dialog' }),
        open === 'library' && h(ProjectLibrary, { t, request, onClose: () => setOpen(null) }),
        open === 'creation' && h(GenerationDialog, { t, request, onClose: () => setOpen(null) }))
    }

    async function readLibrary(projectId, signal, filters = {}, after = null) {
      const query = projectId ? '?' + new URLSearchParams({
        project: projectId, ...filters, ...(after && { after }),
      }) : ''
      const response = await fetch('/api/opendirector/library' + query, { signal })
      if (!response.ok) throw new Error('Project read failed')
      return response.json()
    }

    function ProjectLibrary({ t, request, onClose }) {
      const dialog = useRef(null)
      const [projects, setProjects] = useState(null)
      const [projectId, setProjectId] = useState('')
      const [library, setLibrary] = useState(null)
      const [error, setError] = useState(false)
      const [pending, setPending] = useState(true)
      const [filters, setFilters] = useState(libraryDefaults)
      const [page, setPage] = useState({})
      useEffect(() => {
        dialog.current.showModal()
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        setPending(true)
        setError(false)
        readLibrary(projectId, controller.signal, filters, page.after).then(value => {
          if (controller.signal.aborted) return
          if (projectId) setLibrary(previous => {
            if (!page.after || previous?.projectId !== projectId) return value
            const known = new Set(previous.results.map(result => result.resultId))
            return { ...value, results: [...previous.results, ...value.results.filter(result => !known.has(result.resultId))] }
          })
          else setProjects(value.projects)
          setPending(false)
        }).catch(() => {
          if (controller.signal.aborted) return
          setError(true)
          setPending(false)
        })
        return () => controller.abort()
      }, [projectId, filters, page])
      const current = library?.projectId === projectId ? library : null
      const refresh = () => setPage({})
      function changeProject(id) {
        setProjectId(id)
        setLibrary(null)
        refresh()
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
        ref: dialog, onClose: event => { if (event.target === event.currentTarget) onClose() },
        'aria-label': t('resume'),
        style: dialogStyle,
      },
      h('header', { style: { ...row, justifyContent: 'space-between' } },
        h('strong', null, t('resume')),
        button(t('close'), () => dialog.current.close())),
      h('div', { style: { ...row, marginBlock: '.7rem' } },
        projects?.length > 0 && h('select', {
          value: projectId, onChange: event => changeProject(event.target.value), 'aria-label': t('chooseProject'),
        },
        h('option', { value: '' }, t('chooseProject')),
        ...projects.map(({ id, name }) => h('option', { key: id, value: id }, name))),
        button(t('refresh'), refresh, { disabled: pending }),
        current && canvasLink(current.canvasUrl, t)),
      projectId && h('div', { style: { ...row, marginBlock: '.7rem' } },
        filterControl('kind', 'libraryType', [['all', 'allMedia'], ['image', 'picture'], ['video', 'video'], ['audio', 'audio']]),
        filterControl('selection', 'librarySelection', [['all', 'allSelections'], ['current', 'selected'], ['other', 'other']]),
        filterControl('order', 'libraryOrder', [['newest', 'newest'], ['oldest', 'oldest']])),
      pending && h('p', { role: 'status' }, t('loading')),
      error && h('p', { role: 'alert' }, t('libraryError')),
      projects?.length === 0 && h('p', null, t('projectsEmpty')),
      current && h('section', { 'aria-label': t('recent') },
        h('h3', null, t('recent')),
        current.results.length === 0 ? h('p', null, t(filters.kind === 'all' && filters.selection === 'all' ? 'resultsEmpty' : 'noMatches'))
          : h('div', { style: { display: 'grid', gap: '.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(15rem, 100%), 1fr))' } },
            ...current.results.map(({ resultId, assetId, kind, selected, prompt }, index) => h(Preview, {
              key: resultId, projectId, resultId, assetId, kind, selected, prompt, t, request, canvasUrl: current.canvasUrl,
              title: `${t('candidate')} ${index + 1}`,
              onAdopted: refresh,
            }))),
        current.nextCursor && h('div', { style: { marginTop: '.7rem' } },
          button(t('loadMore'), () => setPage({ after: current.nextCursor }), { disabled: pending }))))
    }

    function ReferencePicker({ projectId, references, setReferences, limit, locked, t }) {
      const [open, setOpen] = useState(false)
      const [after, setAfter] = useState(null)
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
        readLibrary(projectId, controller.signal, { kind: 'image' }, after).then(value => {
          if (controller.signal.aborted) return
          setPage(previous => {
            if (!after || !previous) return value
            const known = new Set(previous.results.map(item => item.resultId))
            return { ...value, results: [...previous.results, ...value.results.filter(item => !known.has(item.resultId))] }
          })
          setLoading(false)
        }).catch(() => {
          if (controller.signal.aborted) return
          setError(true)
          setLoading(false)
        })
        return () => controller.abort()
      }, [pickerOpen, after, projectId])
      function toggle() {
        if (!open) {
          setAfter(null)
          setPage(null)
        }
        setOpen(value => !value)
      }
      function add(image) {
        setReferences(previous => previous.length >= limit || previous.some(item => item.assetId === image.assetId)
          ? previous : [...previous, image])
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
            button('×', () => setReferences(previous => previous.filter(item => item.resultId !== resultId)), {
              disabled: locked, 'aria-label': `${t('removeReference')} ${index + 2}`,
            })))),
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
          page?.nextCursor && button(t('loadMore'), () => setAfter(page.nextCursor), { disabled: loading || full })))
    }

    function GenerationDialog({ source, t, request, onClose }) {
      const dialog = useRef(null)
      const busy = useRef(false)
      const attempt = useRef(null)
      const [catalog, setCatalog] = useState(null)
      const [form, setForm] = useState({ kind: 'image', projectId: '', projectName: '', modelId: '', prompt: '', output: null, voice: '' })
      const [result, setResult] = useState(null)
      const [progress, setProgress] = useState(null)
      const [submitting, setSubmitting] = useState(false)
      const [pollError, setPollError] = useState(false)
      const [pollRun, setPollRun] = useState(0)
      const [references, setReferences] = useState(() => source ? [source] : [])
      const isEdit = Boolean(source)
      const title = t(isEdit ? 'edit' : 'create')
      const choices = catalog?.models.filter(model => model.kind === form.kind && (!source || model.maxImages > 0))
      const model = choices?.find(item => item.id === form.modelId)
      const outputs = model?.imageOutputs ?? []
      const outputIndex = form.output
        ? outputs.findIndex(item => item.size === form.output.size && item.aspectRatio === form.output.aspectRatio) : 0
      const output = outputs[outputIndex]
      const outputUnavailable = Boolean(model && form.output && !output)
      const referenceLimit = model?.maxImages ?? 1
      const tooManyReferences = Boolean(model) && references.length > referenceLimit
      const jobId = result?.jobId
      const projectId = result?.projectId
      const unknown = result?.status === 'unknown'
      const locked = submitting || unknown || Boolean(jobId) || result?.draftSaved === true
      const update = (key, value) => setForm(previous => ({ ...previous, [key]: value,
        ...(key === 'kind' && { modelId: '', output: null }),
        ...((key === 'kind' || key === 'modelId') && { voice: '' }),
      }))
      useEffect(() => {
        dialog.current.showModal()
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        Promise.all([
          isEdit ? Promise.resolve({ projects: [] }) : readLibrary(null, controller.signal),
          fetch('/api/opendirector/creation', { signal: controller.signal }).then(response => {
            if (!response.ok) throw new Error('Model catalog unavailable')
            return response.json()
          }),
        ]).then(([projects, models]) => {
          if (!controller.signal.aborted) setCatalog({ ...projects, ...models })
        }).catch(() => {
          if (!controller.signal.aborted) setCatalog({ error: true, projects: [], models: [] })
        })
        return () => controller.abort()
      }, [isEdit])
      useEffect(() => {
        if (!jobId) return
        const controller = new AbortController()
        let timer
        async function poll() {
          try {
            const params = new URLSearchParams({ project: projectId, job: jobId })
            const response = await fetch('/api/opendirector/creation?' + params, { signal: controller.signal })
            if (!response.ok) throw new Error('Job status unavailable')
            const value = await response.json()
            if (controller.signal.aborted) return
            setProgress(value)
            if (['accepted', 'queued', 'running'].includes(value.status)) timer = setTimeout(poll, 2500)
          } catch {
            if (!controller.signal.aborted) setPollError(true)
          }
        }
        poll()
        return () => { controller.abort(); clearTimeout(timer) }
      }, [jobId, projectId, pollRun])
      async function submit(event) {
        event.preventDefault()
        if (busy.current || (!unknown && (locked || outputUnavailable))) return
        busy.current = true
        setSubmitting(true)
        const check = attempt.current !== null
        try {
          const newProject = !source && form.projectId === 'new'
          attempt.current ??= {
            projectId: source?.projectId ?? (newProject ? crypto.randomUUID() : form.projectId),
            operationId: crypto.randomUUID(),
            ...(source && { sourceResultIds: references.map(item => item.resultId) }),
            ...(newProject && { projectName: form.projectName.trim() }),
            kind: form.kind, modelConfigId: form.modelId, prompt: form.prompt.trim(),
            output, voice: form.voice,
          }
          const response = await fetch('/api/opendirector/creation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-OpenDirector-Action': '1' },
            body: JSON.stringify({ ...attempt.current, check }),
          })
          if (response.status === 400 || response.status === 403) {
            attempt.current = null
            setResult({ status: 'rejected' })
            return
          }
          if (!response.ok) throw new Error('Submission unavailable')
          const value = await response.json()
          setResult({ ...value, projectId: attempt.current.projectId })
          if (value.status !== 'unknown') attempt.current = null
        } catch {
          setResult({ status: attempt.current ? 'unknown' : 'rejected' })
        } finally {
          busy.current = false
          setSubmitting(false)
        }
      }
      function field(label, control) {
        return h('label', { style: { display: 'grid', gap: '.3rem' } }, t(label), cloneElement(control, { 'aria-label': t(label) }))
      }
      const status = progress?.status
      const outcome = status === 'failed' && progress.category === 'quota' ? 'quota'
        : ['cancelled', 'interrupted'].includes(status) ? 'stopped'
          : status === 'accepted' ? 'queued' : status
      return h('dialog', {
        ref: dialog, onClose: event => { if (event.target === event.currentTarget) onClose() },
        'aria-label': title, style: dialogStyle,
      },
        h('header', { style: { ...row, justifyContent: 'space-between' } },
          h('strong', null, title), button(t('close'), () => dialog.current.close())),
        !catalog && h('p', { role: 'status' }, t('loading')),
        catalog?.error && h('p', { role: 'alert' }, t('libraryError')),
        catalog && !catalog.error && h('form', { onSubmit: submit, style: { display: 'grid', gap: '.65rem', marginTop: '.65rem' } },
          !source && field('chooseProject', h('select', {
            required: true, disabled: locked, value: form.projectId, onChange: event => update('projectId', event.target.value),
          }, h('option', { value: '' }, t('chooseProject')),
          ...catalog.projects.map(({ id, name }) => h('option', { key: id, value: id }, name)),
          h('option', { value: 'new' }, t('newProject')))),
          !source && form.projectId === 'new' && field('projectName', h('input', {
            required: true, disabled: locked, value: form.projectName, onChange: event => update('projectName', event.target.value),
          })),
          !source && field('mediaType', h('select', {
            disabled: locked, value: form.kind, onChange: event => update('kind', event.target.value),
          }, h('option', { value: 'image' }, t('picture')), h('option', { value: 'audio' }, t('speech')))),
          field('model', h('select', {
            required: true, disabled: locked, value: form.modelId, onChange: event => update('modelId', event.target.value),
          }, h('option', { value: '' }, t('model')),
          ...choices.map(item => h('option', { key: item.id, value: item.id },
            `${item.modelId} · ${t(item.connectionType === 'self_hosted' ? 'local' : 'hosted')}`)))),
          choices.length === 0 && h('p', null, t('noModels')),
          outputs.length > 0 && field('output', h('select', {
            disabled: locked, value: outputUnavailable ? '' : outputIndex,
            onChange: event => update('output', outputs[Number(event.target.value)]),
          }, outputUnavailable && h('option', { value: '', disabled: true }, t('chooseOutput')),
          ...outputs.map(({ size, aspectRatio }, index) =>
            h('option', { key: index, value: index }, [size, aspectRatio].filter(Boolean).join(' · '))))),
          outputUnavailable && h('p', { role: 'alert' }, t('outputUnavailable').replace('{size}', form.output.size)),
          outputUnavailable && outputs.length === 0 && button(t('useModelDefault'), () => update('output', null), { disabled: locked }),
          form.kind === 'audio' && field('voice', h('input', {
            required: model?.voiceRequired, disabled: locked, maxLength: 200, value: form.voice,
            onChange: event => update('voice', event.target.value),
          })),
          source && h(Preview, { projectId: source.projectId, assetId: source.assetId, kind: source.kind, title: t('original'), t }),
          source && h(ReferencePicker, { projectId: source.projectId, references, setReferences, limit: referenceLimit, locked, t }),
          tooManyReferences && h('p', { role: 'alert' }, t('referencesChanged')),
          field(form.kind === 'audio' ? 'speechText' : source ? 'brief' : 'prompt', h('textarea', {
            required: true, disabled: locked, rows: 3, maxLength: Math.min(model?.maxPromptCharacters ?? 20000, 20000),
            value: form.prompt, onChange: event => update('prompt', event.target.value),
          })),
          (!locked || submitting || unknown) && button(t(submitting ? 'submitting' : unknown ? 'checkGeneration' : 'generate'),
            undefined, { type: 'submit', primary: true,
              disabled: submitting || !model || tooManyReferences || outputUnavailable || !form.prompt.trim() })),
        result?.status === 'rejected' && h('p', { role: 'alert' }, t(result.code === 'storage_busy' ? 'adoptBusy'
          : ['creation.references', 'creation.reference_limit', 'result.candidate_missing'].includes(result.code) ? 'referencesChanged'
            : 'failedToSubmit')),
        unknown && h('p', { role: 'status' }, t('generationUnknown')),
        result?.draftSaved && !jobId && h('p', null, t('draftSaved')),
        jobId && h('p', { role: 'status' }, t(outcome ?? 'waiting')),
        pollError && button(t('checkProgress'), () => { setPollError(false); setPollRun(value => value + 1) }),
        result?.canvasUrl && (jobId || result.draftSaved) && canvasLink(result.canvasUrl, t),
        ...((progress?.results ?? []).map(candidate => h(Preview, {
          ...candidate, projectId, title: t('candidate'), key: candidate.resultId, t, request, canvasUrl: result.canvasUrl,
        }))))
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

    function ResultMenu({ actions, position, trigger, close, t }) {
      const menu = useRef(null)
      useLayoutEffect(() => {
        const element = menu.current
        element.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - element.offsetWidth - 8))}px`
        element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - element.offsetHeight - 8))}px`
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
        ref: menu, role: 'menu', 'aria-label': t('actions'), onKeyDown: keyboard,
        style: { position: 'fixed', zIndex: 100, padding: '.25rem', border, borderRadius: '.45rem',
          background: surface, boxShadow: '0 4px 16px #0004', maxHeight: 'calc(100vh - 16px)', overflow: 'auto' },
      }, ...actions.map(({ label, run, href, ...attributes }) => h(href ? 'a' : 'button', {
        key: label, role: 'menuitem', tabIndex: -1, style,
        ...(href ? { href } : { type: 'button' }), ...attributes,
        onClick: () => { close(); run?.() },
      }, t(label))))
    }

    function Preview({ projectId, assetId, resultId, kind, title, selected, prompt, t, request, onAdopted, canvasUrl }) {
      const [failed, setFailed] = useState(false)
      const [action, setAction] = useState(null)
      const [brief, setBrief] = useState('')
      const [status, setStatus] = useState('')
      const [editing, setEditing] = useState(false)
      const [menu, setMenu] = useState(null)
      const trigger = useRef(null)
      const player = useRef(null)
      const adoption = useAdoption({ projectId, resultId, onAdopted })
      const url = mediaHref(projectId, assetId, kind)
      const downloadUrl = url + '&original=1'
      const video = kind === 'video'
      const audio = kind === 'audio'
      const mediaStyle = { width: '100%', height: 'clamp(8rem, 23vw, 15rem)', display: 'block', objectFit: 'contain',
        borderRadius: '.55rem', background: surface }
      const onError = () => setFailed(true)
      const media = video
        ? h('video', { ref: player, src: url, controls: true, playsInline: true, preload: 'none', 'aria-label': title, onError, style: mediaStyle })
        : audio ? h('audio', { ref: player, src: url, controls: true, preload: 'none', 'aria-label': title, onError, style: { width: '100%' } })
          : h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' },
          h('img', { src: url, alt: title, loading: 'lazy', onError, style: mediaStyle }))
      function message(key, detail = '') {
        return [t(key), t('reference') + ' ' + projectId + ' / ' + resultId, detail].filter(Boolean).join('\n')
      }
      function open(key) {
        setAction(key)
        setStatus('')
      }
      function submit(event) {
        event.preventDefault()
        const detail = brief.trim()
        if (!detail) return
        if (request(message(action, detail), true)) {
          setStatus(t('ready'))
          setAction(null)
          setBrief('')
        } else {
          setStatus(t('draftBusy'))
        }
      }
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
        kind === 'image' && { label: 'edit', run: () => setEditing(true) },
        kind === 'image' && { label: 'firstFrame', run: () => open('firstFramePrompt') },
        video && { label: 'continue', run: () => open('continuePrompt') },
        (video || audio) && !failed && { label: player.current?.paused === false ? 'pause' : 'play', run: togglePlayback },
        !selected && !pending && { label: adoptLabel, run: adoption.adopt },
        { label: 'download', href: downloadUrl, download: '' },
        canvasUrl && { label: 'canvas', href: canvasUrl, target: '_blank', rel: 'noopener noreferrer' },
        { label: 'copyId', run: copyResult },
      ].filter(Boolean)
      return h('figure', {
        onContextMenu: resultId ? contextMenu : undefined,
        style: { margin: 0, minWidth: 0, display: 'grid', gap: '.45rem', alignContent: 'start' },
      },
        h('figcaption', { style: { color: muted, fontSize: '.8em', fontWeight: 600 } }, title),
        failed ? h('p', null, t('unavailable')) : media,
        prompt && h('p', { style: { margin: 0, color: muted, fontSize: '.82em', overflowWrap: 'anywhere' } }, prompt),
        resultId && h('div', { style: { display: 'grid', gap: '.45rem' } },
          h('div', { style: row },
            video && button(t('continue'), () => open('continuePrompt')),
            kind === 'image' && button(t('edit'), () => setEditing(true), { 'aria-haspopup': 'dialog' }),
            kind === 'image' && button(t('firstFrame'), () => open('firstFramePrompt')),
            button(t(adoptLabel), adoption.adopt, { primary: true, disabled: pending || selected }),
            button('···', event => {
              if (menu) closeMenu()
              else {
                const { left, bottom } = event.currentTarget.getBoundingClientRect()
                setMenu({ x: left, y: bottom })
              }
            }, { ref: trigger, 'aria-haspopup': 'menu', 'aria-expanded': Boolean(menu), title: t('actions'), 'aria-label': t('actions') })),
          menu && h(ResultMenu, { actions, position: menu, trigger, close: closeMenu, t }),
          adoption.status && !pending && !selected && !(adoption.status === 'adopted' && onAdopted)
            && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, t(adoption.status)),
          adoption.canvasUrl && !onAdopted && canvasLink(adoption.canvasUrl, t),
          action && h('form', { onSubmit: submit, style: row },
            h('input', {
              autoFocus: true, type: 'text', value: brief, onChange: event => setBrief(event.target.value),
              'aria-label': t('shot'),
              placeholder: t('shot'),
              style: { ...buttonStyle, flex: '1 1 10rem', minWidth: 0, cursor: 'text' },
            }),
            button(t('send'), undefined, { type: 'submit', primary: true, disabled: !brief.trim() }),
            button(t('cancel'), () => { setAction(null); setBrief(''); setStatus('') })),
          status && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, status)),
        editing && h(GenerationDialog, {
          source: { projectId, assetId, resultId, kind }, t, request, onClose: () => setEditing(false),
        }))
    }

    function canvasLink(url, t) {
      return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
        style: { ...buttonStyle, textDecoration: 'none', whiteSpace: 'nowrap' } }, `${t('canvas')} ↗`)
    }

    function MediaResults({ meta, t, request }) {
      const preview = meta.mediaPreview ?? meta.imagePreview
      const kind = preview.kind ?? 'image'
      const heading = t(kind === 'video' ? 'videos' : kind === 'audio' ? 'audios' : 'images')
      const sourceKind = preview.sourceKind ?? kind
      return h('section', { 'aria-label': heading, [`data-opendirector-${kind}-results`]: '',
        style: { display: 'grid', gap: '.75rem', padding: '.85rem 1rem', border, borderRadius: '.9rem' } },
        h('header', { style: { ...row, justifyContent: 'space-between' } },
          h('div', { style: { display: 'grid', gap: '.1rem' } },
            h('span', { style: { color: muted, fontSize: '.73em' } }, `OpenDirector · ${heading}`),
            h('strong', { style: { fontSize: '1em', overflowWrap: 'anywhere' } }, preview.projectName)),
          canvasLink(meta.canvasUrl, t)),
        h('div', { style: { display: 'grid', gap: '.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(12rem, 100%), 1fr))' } },
          preview.sourceAssetId && h(Preview, {
            key: preview.sourceAssetId, projectId: meta.projectId, assetId: preview.sourceAssetId,
            kind: sourceKind, title: t(sourceKind === 'video' ? 'sourceClip' : 'original'), t,
          }),
          ...preview.candidates.map(({ resultId, assetId }, index) => h(Preview, {
            key: resultId, projectId: meta.projectId, assetId, resultId, kind, t, request, canvasUrl: meta.canvasUrl,
            title: preview.candidates.length > 1 ? `${t('candidate')} ${index + 1}` : t('candidate'),
          }))))
    }

    function MediaResultsTail({ turn, useChat, useInput, inputActions, t }) {
      const source = useChat(snapshot => snapshot.nodes.turnDataSource(turn.turn, 'tool-call'))
      const calls = useSyncExternalStore(source.subscribe, source.getSnapshot)
      const request = useComposerRequest(useInput, inputActions)
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
      return h('div', { style: { display: 'grid', gap: '.65rem' } },
        ...Array.from(previews, ([key, meta]) => h(MediaResults, { key, meta, t, request })),
        ...Array.from(adoptions, ([key, url]) => h('div', {
          key, 'data-opendirector-adoption': '', style: { ...row, justifyContent: 'space-between',
            padding: '.5rem .7rem', border, borderRadius: '.55rem', fontSize: '.9em' },
        }, h('strong', null, t('adopted')), canvasLink(url, t))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, { en, zh }))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: '@opendirector/dsh-plugin', locale: namespace,
        }, MediaResultsTail))
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: '@opendirector/dsh-plugin:create', locale: namespace,
        }, CreateMedia))
      },
    }
  },
})
