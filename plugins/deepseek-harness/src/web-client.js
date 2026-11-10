/* DSH loads client exports through its browser module loader. React comes from the host. */
window.__ModuleLoader__.load({
  id: '@opendirector/dsh-plugin',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState, useSyncExternalStore } = require('react')
    const namespace = 'opendirector'
    const en = {
      images: 'Image results', videos: 'Video results', original: 'Original', sourceClip: 'Source clip',
      candidate: 'Candidate', unavailable: 'Preview unavailable. Open the canvas to view this result.',
      canvas: 'Open canvas', edit: 'Edit', firstFrame: 'Animate', continue: 'Continue', adopt: 'Adopt', adopted: 'Result adopted',
      create: 'Create media', send: 'Send request', cancel: 'Cancel',
      draftBusy: 'Finish or clear your current draft first.', brief: 'Describe what to change',
      shot: 'Describe the next shot', ready: 'Request sent.', copyId: 'Copy result ID', copied: 'Result ID copied.',
      createPrompt: 'Create in OpenDirector: ',
      editPrompt: 'Edit the image. Show the new candidate before adopting it.',
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
      reference: 'OpenDirector project and result',
    }
    const zh = {
      images: '图片结果', videos: '视频结果', original: '原图', sourceClip: '源片段',
      candidate: '候选', unavailable: '暂时无法预览。可在画布查看。',
      canvas: '打开画布', edit: '改图', firstFrame: '转成视频', continue: '续写', adopt: '采用', adopted: '已采用结果',
      create: '创作素材', send: '发送请求', cancel: '取消',
      draftBusy: '请先发送或清空当前草稿。', brief: '描述你想改什么',
      shot: '描述接下来的镜头', ready: '请求已发送。', copyId: '复制结果 ID', copied: '已复制结果 ID。',
      createPrompt: '用 OpenDirector 创作：',
      editPrompt: '修改这张图片，先展示修改候选，再由我决定是否采用。',
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
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      return h('div', { style: row },
        button(t('create'), () => setBusy(!request(t('createPrompt'))), { title: 'OpenDirector' }),
        button(t('resume'), () => setOpen(true), { 'aria-haspopup': 'dialog' }),
        busy && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, t('draftBusy')),
        open && h(ProjectLibrary, { t, request, onClose: () => setOpen(false) }))
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
        ref: dialog, onClose, 'aria-label': t('resume'),
        style: { width: 'min(46rem, calc(100vw - 2rem))', maxHeight: '80vh',
          boxSizing: 'border-box', color: 'inherit', background: surface, border, borderRadius: '.85rem', padding: '1rem' },
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
      const url = '/api/opendirector/media?' + new URLSearchParams({ project: projectId, asset: assetId, kind })
      const video = kind === 'video'
      const mediaStyle = { width: '100%', height: 'clamp(8rem, 23vw, 15rem)', display: 'block', objectFit: 'contain',
        borderRadius: '.55rem', background: surface }
      const onError = () => setFailed(true)
      const media = video
        ? h('video', { src: url, controls: true, playsInline: true, preload: 'none', 'aria-label': title, onError, style: mediaStyle })
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
            video ? button(t('continue'), () => open('continuePrompt')) : button(t('edit'), () => open('editPrompt')),
            !video && button(t('firstFrame'), () => open('firstFramePrompt')),
            button('ID', copyResult, { title: t('copyId'), 'aria-label': t('copyId') })),
          h(AdoptResult, { projectId, resultId, selected, t, onAdopted }),
          action && h('form', { onSubmit: submit, style: row },
            h('input', {
              autoFocus: true, type: 'text', value: brief, onChange: event => setBrief(event.target.value),
              'aria-label': t(action === 'editPrompt' ? 'brief' : 'shot'),
              placeholder: t(action === 'editPrompt' ? 'brief' : 'shot'),
              style: { ...buttonStyle, flex: '1 1 10rem', minWidth: 0, cursor: 'text' },
            }),
            button(t('send'), undefined, { type: 'submit', primary: true, disabled: !brief.trim() }),
            button(t('cancel'), () => { setAction(null); setBrief(''); setStatus('') })),
          status && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, status)))
    }

    function canvasLink(url, t) {
      return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
        style: { ...buttonStyle, textDecoration: 'none', whiteSpace: 'nowrap' } }, `${t('canvas')} ↗`)
    }

    function MediaResults({ meta, t, request }) {
      const preview = meta.mediaPreview ?? meta.imagePreview
      const kind = preview.kind ?? 'image'
      const heading = t(kind === 'video' ? 'videos' : 'images')
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
