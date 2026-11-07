/* DSH loads client exports through its browser module loader. React comes from the host. */
window.__ModuleLoader__.load({
  id: '@opendirector/dsh-plugin',
  factory(require) {
    const { createElement: h, useState, useSyncExternalStore } = require('react')

    const messages = {
      'en-US': {
        heading: 'OpenDirector image results',
        source: 'Source image',
        candidate: 'Generated image',
        videoHeading: 'OpenDirector video results',
        videoSource: 'Source clip',
        videoCandidate: 'Generated clip',
        unavailable: 'Preview unavailable. Open the canvas to inspect the result.',
        canvas: 'Open in OpenDirector',
        edit: 'Edit image',
        firstFrame: 'Use as video first frame',
        continue: 'Continue video',
        adopt: 'Adopt result',
        drafted: 'Added to your draft. Review it before sending.',
        draftBusy: 'Your draft was kept. Finish or clear it before starting this action.',
        prompt: (projectId, resultId) =>
          `Edit OpenDirector image result ${resultId} in project ${projectId}. Show me the edit before adopting it. What to change: `,
        firstFramePrompt: (projectId, resultId) =>
          `Use image result ${resultId} in OpenDirector project ${projectId} as the first frame of a video. Show me the video candidate before adopting it. Describe the shot: `,
        continuePrompt: (projectId, resultId) =>
          `Continue from video result ${resultId} in OpenDirector project ${projectId} using a model that supports video continuation. Show me the candidate before adopting it. Continue with: `,
        adoptPrompt: (projectId, resultId) =>
          `Adopt OpenDirector result ${resultId} in project ${projectId}. Read the current project revisions before adopting it, then give me the canvas link.`,
      },
      'zh-CN': {
        heading: 'OpenDirector 图片结果',
        source: '原图',
        candidate: '生成候选',
        videoHeading: 'OpenDirector 视频结果',
        videoSource: '源片段',
        videoCandidate: '生成片段',
        unavailable: '暂时无法预览，可以打开画布查看结果。',
        canvas: '在 OpenDirector 打开',
        edit: '修改图片',
        firstFrame: '用作视频首帧',
        continue: '续写视频',
        adopt: '采用结果',
        drafted: '已填入输入框，检查后再发送。',
        draftBusy: '已保留当前草稿，请先发出或清空再操作。',
        prompt: (projectId, resultId) =>
          `请修改 OpenDirector 工程 ${projectId} 中的图片结果 ${resultId}，先展示修改候选，等我确认后再采用。修改要求：`,
        firstFramePrompt: (projectId, resultId) =>
          `用 OpenDirector 工程 ${projectId} 中的图片结果 ${resultId} 作为视频首帧，先展示候选，等我确认后再采用。镜头要求：`,
        continuePrompt: (projectId, resultId) =>
          `用支持续写的模型接着生成 OpenDirector 工程 ${projectId} 中的视频结果 ${resultId}，先展示候选，等我确认后再采用。接下来的画面：`,
        adoptPrompt: (projectId, resultId) =>
          `采用 OpenDirector 工程 ${projectId} 中的结果 ${resultId}。先读取工程当前的版本号，采用后给我画布链接。`,
      },
    }

    function Preview({ projectId, assetId, resultId, kind, title, t, stageDraft }) {
      const [failed, setFailed] = useState(false)
      const [draftStatus, setDraftStatus] = useState('')
      const url = '/api/opendirector/media?' + new URLSearchParams({ project: projectId, asset: assetId, kind })
      const video = kind === 'video'
      const mediaStyle = {
        display: 'block', width: '100%', height: 'clamp(9rem, 28vw, 17rem)',
        objectFit: 'contain', borderRadius: '.5rem', background: 'var(--dsw-alias-markdown-code-block)',
      }
      const onError = () => setFailed(true)
      const media = video
        ? h('video', { src: url, controls: true, playsInline: true, preload: 'none', 'aria-label': title, onError, style: mediaStyle })
        : h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' },
          h('img', { src: url, alt: title, loading: 'lazy', onError, style: mediaStyle }))
      const button = (label, prompt) => h('button', {
        type: 'button', onClick: () => setDraftStatus(stageDraft(prompt(projectId, resultId)) ? t.drafted : t.draftBusy),
        style: {
          font: 'inherit', fontSize: '.85em', padding: '.2rem .5rem', borderRadius: '.35rem',
          border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)',
          color: 'inherit', cursor: 'pointer',
        },
      }, label)
      return h('figure', { style: { margin: 0, minWidth: 0, display: 'grid', gap: '.4rem', alignContent: 'start' } },
        h('figcaption', { style: { fontSize: '.85em', fontWeight: 600 } }, title),
        failed ? h('p', null, t.unavailable) : media,
        resultId && h('div', { style: { display: 'grid', gap: '.25rem', justifyItems: 'start' } },
          h('code', { style: { fontSize: '.75em', overflowWrap: 'anywhere' } }, resultId),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.3rem' } },
            video ? button(t.continue, t.continuePrompt) : button(t.edit, t.prompt),
            !video && button(t.firstFrame, t.firstFramePrompt),
            button(t.adopt, t.adoptPrompt)),
          h('span', { role: 'status', style: { fontSize: '.8em' } }, draftStatus)))
    }

    function MediaResults({ meta, stageDraft }) {
      const preview = meta.mediaPreview ?? meta.imagePreview
      const kind = preview.kind ?? 'image'
      const t = messages[preview.locale] ?? messages['en-US']
      const heading = kind === 'video' ? t.videoHeading : t.heading
      const candidate = kind === 'video' ? t.videoCandidate : t.candidate
      const sourceKind = preview.sourceKind ?? kind
      return h('section', { 'aria-label': heading, [`data-opendirector-${kind}-results`]: '',
        style: { display: 'grid', gap: '.65rem', padding: '.8rem',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '.65rem' } },
        h('header', null,
          h('strong', null, heading), preview.projectName && h('span', null, ' · ', preview.projectName)),
        h('div', {
          style: { display: 'grid', gap: '.8rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(13rem, 100%), 1fr))' },
        },
        preview.sourceAssetId && h(Preview, {
          key: preview.sourceAssetId, projectId: meta.projectId, assetId: preview.sourceAssetId,
          kind: sourceKind, title: sourceKind === 'video' ? t.videoSource : t.source, t,
        }),
        ...preview.candidates.map(({ resultId, assetId }, index) => h(Preview, {
          key: resultId, projectId: meta.projectId, assetId, resultId, kind, t, stageDraft,
          title: preview.candidates.length > 1 ? `${candidate} ${index + 1}` : candidate,
        }))),
        h('a', { href: meta.canvasUrl, target: '_blank', rel: 'noopener noreferrer' }, t.canvas))
    }

    function MediaResultsTail({ turn, useChat, useInput, inputActions }) {
      const source = useChat(snapshot => snapshot.nodes.turnDataSource(turn.turn, 'tool-call'))
      const calls = useSyncExternalStore(source.subscribe, source.getSnapshot)
      const emptyRevision = useInput(state => state.phase === 'plain' && !state.draft.trim()
        && !state.attachmentIds.length && !state.occurrences.length ? state.draftRev : null)
      function stageDraft(text) {
        if (emptyRevision === null) return false
        const span = inputActions.captureInsertion()
        return span.draftRev === emptyRevision && inputActions.insertText(text, span)
      }
      const previews = new Map()
      for (const { root } of calls) {
        if (root.name === 'opendirector_job' && (root.meta?.mediaPreview || root.meta?.imagePreview)) {
          previews.set(root.meta.jobId, root.meta)
        }
      }
      if (!previews.size) return null
      return h('div', { style: { display: 'grid', gap: '.65rem' } },
        ...Array.from(previews, ([key, meta]) => h(MediaResults, { key, meta, stageDraft })))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: '@opendirector/dsh-plugin',
        }, MediaResultsTail))
      },
    }
  },
})
