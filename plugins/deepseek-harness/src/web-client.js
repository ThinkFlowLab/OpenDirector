/* DSH loads client exports through its browser module loader. React comes from the host. */
window.__ModuleLoader__.load({
  id: '@opendirector/dsh-plugin',
  factory(require) {
    const { cloneElement, createElement: h, useEffect, useRef, useState, useSyncExternalStore } = require('react')
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
      projectsEmpty: 'No OpenDirector projects yet.', resultsEmpty: 'This project has no saved images or videos.',
      loading: 'Loading…', refresh: 'Refresh results', libraryError: 'Could not load OpenDirector. Try refreshing.',
      recent: 'Recent results', selected: 'Current result', adopting: 'Adopting…', checkAdoption: 'Check adoption',
      adoptUnknown: 'Adoption has not been confirmed yet. Check its status.',
      adoptBusy: 'Save and close the open OpenDirector canvas, then try again.',
      adoptConflict: 'This result or canvas has changed. Refresh the project before trying again.',
      adoptFailed: 'Could not adopt this result. Check the project and try again.',
      audios: 'Audio results', speech: 'Voiceover', picture: 'Image', mediaType: 'Media type',
      newProject: 'New project', projectName: 'Project name', model: 'Model', local: 'Self-hosted', hosted: 'Hosted',
      output: 'Image size', voice: 'Voice ID', prompt: 'Describe the image', speechText: 'Text to read aloud',
      generate: 'Generate one candidate', submitting: 'Submitting…', checkGeneration: 'Check submission',
      noModels: 'Configure a compatible model in OpenDirector first.',
      failedToSubmit: 'Could not submit generation. Check your project and model settings.',
      generationUnknown: 'Submission has not been confirmed. Check the original operation.',
      draftSaved: 'The generation settings are saved on the canvas.',
      waiting: 'Waiting for OpenDirector…', queued: 'Queued', running: 'Generating…',
      succeeded: 'Candidate ready', stopped: 'Generation stopped', failed: 'Generation failed',
      quota: 'The model service reported a quota error. Check the provider before trying again.',
      checkProgress: 'Check progress', download: 'Download',
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
      projectsEmpty: '还没有 OpenDirector 工程。', resultsEmpty: '这个工程还没有保存图片或视频。',
      loading: '加载中…', refresh: '刷新结果', libraryError: '暂时无法读取 OpenDirector，请刷新重试。',
      recent: '最近的结果', selected: '当前结果', adopting: '正在采用…', checkAdoption: '查询采用状态',
      adoptUnknown: '尚未确认是否采用，请查询状态。',
      adoptBusy: '请保存并关闭已打开的 OpenDirector 画布，然后重试。',
      adoptConflict: '结果或画布状态已变，请刷新工程后再试。',
      adoptFailed: '暂时无法采用此结果，请检查工程后重试。',
      audios: '音频结果', speech: '配音', picture: '图片', mediaType: '素材类型',
      newProject: '新建工程', projectName: '工程名称', model: '模型', local: '自部署', hosted: '在线服务',
      output: '图片尺寸', voice: '音色 ID', prompt: '描述要生成的图片', speechText: '要朗读的文字',
      generate: '生成一个候选', submitting: '正在提交…', checkGeneration: '查询提交状态',
      noModels: '请先在 OpenDirector 配置支持此操作的模型。',
      failedToSubmit: '暂时无法提交生成，请检查工程和模型设置。',
      generationUnknown: '尚未确认任务是否提交，请查询原操作。',
      draftSaved: '本次生成配置已保存到画布。',
      waiting: '等待 OpenDirector…', queued: '排队中', running: '生成中…',
      succeeded: '候选已生成', stopped: '生成已停止', failed: '生成失败',
      quota: '模型服务返回额度错误，请检查服务商后再试。',
      checkProgress: '查询进度', download: '下载',
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

    function button(label, onClick, options = {}) {
      const { primary, ...attrs } = options
      return h('button', {
        type: 'button', onClick, ...attrs,
        style: { ...buttonStyle, ...(primary && { background: surface, fontWeight: 600 }) },
      }, label)
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

    async function readLibrary(projectId, signal) {
      const query = projectId ? '?' + new URLSearchParams({ project: projectId }) : ''
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
      const [refresh, setRefresh] = useState(0)
      useEffect(() => {
        dialog.current.showModal()
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        setPending(true)
        setError(false)
        readLibrary(projectId, controller.signal).then(value => {
          if (controller.signal.aborted) return
          if (projectId) setLibrary(value)
          else setProjects(value.projects)
          setPending(false)
        }).catch(() => {
          if (controller.signal.aborted) return
          setError(true)
          setPending(false)
        })
        return () => controller.abort()
      }, [projectId, refresh])
      const current = library?.projectId === projectId ? library : null
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
          value: projectId, onChange: event => setProjectId(event.target.value), 'aria-label': t('chooseProject'),
        },
        h('option', { value: '' }, t('chooseProject')),
        ...projects.map(({ id, name }) => h('option', { key: id, value: id }, name))),
        button(t('refresh'), () => setRefresh(value => value + 1), { disabled: pending }),
        current && canvasLink(current.canvasUrl, t)),
      pending && h('p', { role: 'status' }, t('loading')),
      error && h('p', { role: 'alert' }, t('libraryError')),
      projects?.length === 0 && h('p', null, t('projectsEmpty')),
      current && h('section', { 'aria-label': t('recent') },
        h('h3', null, t('recent')),
        current.results.length === 0 ? h('p', null, t('resultsEmpty'))
          : h('div', { style: { display: 'grid', gap: '.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(15rem, 100%), 1fr))' } },
            ...current.results.map(({ resultId, assetId, kind, selected, prompt }, index) => h(Preview, {
              key: resultId, projectId, resultId, assetId, kind, selected, prompt, t, request,
              title: `${t('candidate')} ${index + 1}`,
              onAdopted: () => setRefresh(value => value + 1),
            })))))
    }

    function GenerationDialog({ source, t, request, onClose }) {
      const dialog = useRef(null)
      const busy = useRef(false)
      const attempt = useRef(null)
      const [catalog, setCatalog] = useState(null)
      const [form, setForm] = useState({ kind: 'image', projectId: '', projectName: '', modelId: '', prompt: '', output: 0, voice: '' })
      const [result, setResult] = useState(null)
      const [progress, setProgress] = useState(null)
      const [submitting, setSubmitting] = useState(false)
      const [pollError, setPollError] = useState(false)
      const [pollRun, setPollRun] = useState(0)
      const isEdit = Boolean(source)
      const title = t(isEdit ? 'edit' : 'create')
      const choices = catalog?.models.filter(model => model.kind === form.kind && (!source || model.canEdit))
      const model = choices?.find(item => item.id === form.modelId)
      const jobId = result?.jobId
      const projectId = result?.projectId
      const unknown = result?.status === 'unknown'
      const locked = submitting || unknown || Boolean(jobId) || result?.draftSaved === true
      const update = (key, value) => setForm(previous => ({ ...previous, [key]: value,
        ...(key === 'kind' && { modelId: '' }),
        ...((key === 'kind' || key === 'modelId') && { output: 0, voice: '' }),
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
        if (busy.current || (locked && !unknown)) return
        busy.current = true
        setSubmitting(true)
        const check = attempt.current !== null
        try {
          const newProject = !source && form.projectId === 'new'
          attempt.current ??= {
            projectId: source?.projectId ?? (newProject ? crypto.randomUUID() : form.projectId),
            operationId: crypto.randomUUID(),
            ...(source && { sourceResultId: source.resultId }),
            ...(newProject && { projectName: form.projectName.trim() }),
            kind: form.kind, modelConfigId: form.modelId, prompt: form.prompt.trim(),
            output: model?.imageOutputs[form.output], voice: form.voice,
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
          model?.imageOutputs.length > 0 && field('output', h('select', {
            disabled: locked, value: form.output, onChange: event => update('output', Number(event.target.value)),
          }, ...model.imageOutputs.map(({ size, aspectRatio }, index) =>
            h('option', { key: index, value: index }, [size, aspectRatio].filter(Boolean).join(' · '))))),
          form.kind === 'audio' && field('voice', h('input', {
            required: model?.voiceRequired, disabled: locked, maxLength: 200, value: form.voice,
            onChange: event => update('voice', event.target.value),
          })),
          source && h(Preview, { projectId: source.projectId, assetId: source.assetId, kind: source.kind, title: t('original'), t }),
          field(form.kind === 'audio' ? 'speechText' : source ? 'brief' : 'prompt', h('textarea', {
            required: true, disabled: locked, rows: 3, maxLength: Math.min(model?.maxPromptCharacters ?? 20000, 20000),
            value: form.prompt, onChange: event => update('prompt', event.target.value),
          })),
          (!locked || submitting || unknown) && button(t(submitting ? 'submitting' : unknown ? 'checkGeneration' : 'generate'),
            undefined, { type: 'submit', primary: true, disabled: submitting || !model || !form.prompt.trim() })),
        result?.status === 'rejected' && h('p', { role: 'alert' }, t(result.code === 'storage_busy' ? 'adoptBusy' : 'failedToSubmit')),
        unknown && h('p', { role: 'status' }, t('generationUnknown')),
        result?.draftSaved && !jobId && h('p', null, t('draftSaved')),
        jobId && h('p', { role: 'status' }, t(outcome ?? 'waiting')),
        pollError && button(t('checkProgress'), () => { setPollError(false); setPollRun(value => value + 1) }),
        result?.canvasUrl && (jobId || result.draftSaved) && canvasLink(result.canvasUrl, t),
        ...((progress?.results ?? []).map(candidate => h(Preview, {
          ...candidate, projectId, title: t('candidate'), key: candidate.resultId, t, request,
        }))))
    }

    function AdoptResult({ projectId, resultId, selected, t, onAdopted }) {
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
      const pending = status === 'adopting'
      const label = pending ? 'adopting' : selected ? 'selected'
        : status === 'adoptUnknown' ? 'checkAdoption' : 'adopt'
      return h('div', { style: row },
        button(t(label), adopt, { primary: true, disabled: pending || selected }),
        status && !pending && !selected && !(status === 'adopted' && onAdopted)
          && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, t(status)),
        canvasUrl && !onAdopted && canvasLink(canvasUrl, t))
    }

    function Preview({ projectId, assetId, resultId, kind, title, selected, prompt, t, request, onAdopted }) {
      const [failed, setFailed] = useState(false)
      const [action, setAction] = useState(null)
      const [brief, setBrief] = useState('')
      const [status, setStatus] = useState('')
      const [editing, setEditing] = useState(false)
      const url = '/api/opendirector/media?' + new URLSearchParams({ project: projectId, asset: assetId, kind })
      const video = kind === 'video'
      const audio = kind === 'audio'
      const mediaStyle = { width: '100%', height: 'clamp(8rem, 23vw, 15rem)', display: 'block', objectFit: 'contain',
        borderRadius: '.55rem', background: surface }
      const onError = () => setFailed(true)
      const media = video
        ? h('video', { src: url, controls: true, playsInline: true, preload: 'none', 'aria-label': title, onError, style: mediaStyle })
        : audio ? h('audio', { src: url, controls: true, preload: 'none', 'aria-label': title, onError, style: { width: '100%' } })
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
      return h('figure', { style: { margin: 0, minWidth: 0, display: 'grid', gap: '.45rem', alignContent: 'start' } },
        h('figcaption', { style: { color: muted, fontSize: '.8em', fontWeight: 600 } }, title),
        failed ? h('p', null, t('unavailable')) : media,
        prompt && h('p', { style: { margin: 0, color: muted, fontSize: '.82em', overflowWrap: 'anywhere' } }, prompt),
        resultId && h('div', { style: { display: 'grid', gap: '.45rem' } },
          h('div', { style: row },
            video && button(t('continue'), () => open('continuePrompt')),
            kind === 'image' && button(t('edit'), () => setEditing(true), { 'aria-haspopup': 'dialog' }),
            kind === 'image' && button(t('firstFrame'), () => open('firstFramePrompt')),
            (video || audio) && h('a', { href: url, download: '', style: buttonStyle }, t('download')),
            button('ID', copyResult, { title: t('copyId'), 'aria-label': t('copyId') })),
          h(AdoptResult, { projectId, resultId, selected, t, onAdopted }),
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
            key: resultId, projectId: meta.projectId, assetId, resultId, kind, t, request,
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
