/* DSH loads client exports through its browser module loader. React comes from the host. */
window.__ModuleLoader__.load({
  id: '@opendirector/dsh-plugin',
  factory(require) {
    const { createElement: h, useState, useSyncExternalStore } = require('react')
    const namespace = 'opendirector'
    const en = {
      images: 'Image results', videos: 'Video results', original: 'Original', sourceClip: 'Source clip',
      candidate: 'Candidate', unavailable: 'Preview unavailable. Open the canvas to view this result.',
      canvas: 'Open canvas', edit: 'Edit', firstFrame: 'Animate', continue: 'Continue', adopt: 'Adopt', adopted: 'Result adopted',
      create: 'Create media', send: 'Send request', cancel: 'Cancel', draftReady: 'Draft ready to send.',
      draftBusy: 'Finish or clear your current draft first.', brief: 'Describe what to change',
      shot: 'Describe the next shot', ready: 'Request sent.', copyId: 'Copy result ID', copied: 'Result ID copied.',
      createPrompt: 'Create in OpenDirector: ',
      editPrompt: 'Edit the image. Show the new candidate before adopting it.',
      firstFramePrompt: 'Use the image as the first frame of a video. Show the candidate before adopting it.',
      continuePrompt: 'Continue the clip with a compatible video model. Show the candidate before adopting it.',
      adoptPrompt: 'Adopt this result. Read the current revisions first, then share the canvas link.',
      reference: 'OpenDirector project and result',
    }
    const zh = {
      images: '图片结果', videos: '视频结果', original: '原图', sourceClip: '源片段',
      candidate: '候选', unavailable: '暂时无法预览。可在画布查看。',
      canvas: '打开画布', edit: '改图', firstFrame: '转成视频', continue: '续写', adopt: '采用', adopted: '已采用结果',
      create: '创作素材', send: '发送请求', cancel: '取消', draftReady: '草稿已填入，检查后发送。',
      draftBusy: '请先发送或清空当前草稿。', brief: '描述你想改什么',
      shot: '描述接下来的镜头', ready: '请求已发送。', copyId: '复制结果 ID', copied: '已复制结果 ID。',
      createPrompt: '用 OpenDirector 创作：',
      editPrompt: '修改这张图片，先展示修改候选，再由我决定是否采用。',
      firstFramePrompt: '用这张图片作为视频首帧，先展示候选，再由我决定是否采用。',
      continuePrompt: '用支持续写的模型接着生成这段视频，先展示候选，再由我决定是否采用。',
      adoptPrompt: '采用此结果，先读取工程当前版本，采用后给我画布链接。',
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
      return h('div', { style: row },
        button(t('create'), () => setBusy(!request(t('createPrompt'))), { title: 'OpenDirector' }),
        busy && h('span', { role: 'status', style: { color: muted, fontSize: '.78em' } }, t('draftBusy')))
    }

    function Preview({ projectId, assetId, resultId, kind, title, t, request }) {
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
        resultId && h('div', { style: { display: 'grid', gap: '.45rem' } },
          h('div', { style: row },
            video ? button(t('continue'), () => open('continuePrompt')) : button(t('edit'), () => open('editPrompt')),
            !video && button(t('firstFrame'), () => open('firstFramePrompt')),
            button(t('adopt'), () => setStatus(t(request(message('adoptPrompt')) ? 'draftReady' : 'draftBusy')), { primary: true }),
            button('···', copyResult, { title: t('copyId'), 'aria-label': t('copyId') })),
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
