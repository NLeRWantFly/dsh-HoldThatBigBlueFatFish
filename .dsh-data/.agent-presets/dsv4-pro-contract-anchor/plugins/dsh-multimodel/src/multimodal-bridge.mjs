import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enforceCompletionBoundary } from './protocol.mjs'
import { runVisionBackend, selectedBackend } from './backends.mjs'

export const name = 'dsh-multimodal-bridge'
export const inject = ['tools', 'systemPrompt', 'attachments', 'fs']
export const TOOL_NAME = 'perceive_media'
export const BRIDGE_META_KEY = 'multimodalBridge'

const RESULT_OPEN = '<dsh_multimodal_result>'
const RESULT_CLOSE = '</dsh_multimodal_result>'
const MEDIA_REF_PREFIX = '[dsh_media_ref] '
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])
const SCHEMA_PATH = fileURLToPath(new URL('../schemas/vision-result.schema.json', import.meta.url))

const TOOL_DESCRIPTION = [
  'Inspect the image attachments in the current conversation through a real vision backend.',
  'Call before making any visual claim. For a new analysis omit analysis_id; for follow-up use the returned analysis_id.',
  'If status is needs_followup, ask one materially narrower question from suggested_followups and call again.',
  'Stop only at complete or blocked. exhaustive means task-relative saturation with OCR, layout, detail, and uncertainty coverage.',
].join(' ')

function text(value, limit = 2_000) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizedImageRef(value) {
  if (!value || typeof value !== 'object') return undefined
  if (typeof value.attachmentId !== 'string' || value.attachmentId.length === 0) return undefined
  if (typeof value.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(value.mediaType)) return undefined
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) return undefined
  if (!Number.isSafeInteger(value.width) || value.width <= 0) return undefined
  if (!Number.isSafeInteger(value.height) || value.height <= 0) return undefined
  return {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(typeof value.name === 'string' && value.name.length > 0 ? { name: value.name } : {}),
  }
}

function imageReadContent(value) {
  return [{
    type: 'text',
    text: `<path>${value.path}</path>\n<type>image</type>\n<content>\n${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes\n</content>`,
  }, {
    type: 'image',
    attachment: value.image,
  }]
}

export function applyReadImageBridge(ctx) {
  return ctx.tools.register({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF file and attach it for perceive_media without sending a raw image block to the text-only provider.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the image file, resolved by the filesystem backend.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'image'],
        properties: {
          path: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string', enum: [...IMAGE_MEDIA_TYPES] },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => imageReadContent(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requestedPath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
      if (!requestedPath) throw new Error('file_path must be a non-empty string')
      const mediaType = IMAGE_EXTENSIONS.get(extname(requestedPath).toLowerCase())
      if (!mediaType) throw new Error(`cannot read "${requestedPath}": read_image only accepts PNG/JPEG/WebP/GIF paths`)
      if (!ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot read "${requestedPath}": ${mediaType} images are not accepted by this deployment`)
      }
      const cwd = exec.agent?.session?.header?.cwd
      const target = await ctx.fs.resolve(requestedPath, {
        ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
        signal: exec.signal,
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (!info) throw new Error(`cannot read "${target.displayPath}": not found`)
      if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`)
      const byteCap = Math.min(
        ctx.attachments.imageLimits.maxImageBytes,
        ctx.attachments.imageLimits.maxMessageImageBytes,
      )
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      const ref = await ctx.attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return {
        path: target.displayPath,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
        },
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Read image ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  })
}

function refsFromMarker(value) {
  if (typeof value !== 'string') return []
  const refs = []
  for (const line of value.split(/\r?\n/u)) {
    if (!line.startsWith(MEDIA_REF_PREFIX)) continue
    try {
      const ref = normalizedImageRef(JSON.parse(line.slice(MEDIA_REF_PREFIX.length)))
      if (ref) refs.push(ref)
    } catch {}
  }
  return refs
}

export function extractRawImageRefs(content) {
  const refs = []
  for (const block of asArray(content)) {
    if (block?.type === 'image' && block.attachment && typeof block.attachment === 'object') {
      const ref = normalizedImageRef(block.attachment)
      if (ref) refs.push(ref)
    } else if (block?.type === 'tool-result') {
      refs.push(...extractRawImageRefs(block.content))
    }
  }
  return refs
}

export function extractImageRefs(content) {
  const refs = []
  for (const block of asArray(content)) {
    if (block?.type === 'image') {
      const ref = normalizedImageRef(block.attachment)
      if (ref) refs.push(ref)
    } else if (block?.type === 'text') {
      refs.push(...refsFromMarker(block.text))
    } else if (block?.type === 'tool-result') {
      refs.push(...extractImageRefs(block.content))
    }
  }
  return refs
}

function imageMarker(ref, perceptionActive, perceptionEnabled) {
  const namePart = ref.name ? ` name=${JSON.stringify(ref.name)}` : ''
  const action = !perceptionEnabled
    ? 'visual perception is disabled; do not make visual claims'
    : perceptionActive
      ? 'call perceive_media before visual claims'
      : 'use the prior perceive_media result for visual facts'
  return `${MEDIA_REF_PREFIX}${JSON.stringify(ref)}\n<dsh_media kind="image" id=${JSON.stringify(ref.attachmentId)} media_type=${JSON.stringify(ref.mediaType)} size="${ref.width}x${ref.height}"${namePart} action=${JSON.stringify(action)} />`
}

function sanitizeBlocks(content, perceptionActive, perceptionEnabled = true) {
  return asArray(content).flatMap((block) => {
    if (block?.type === 'image') {
      const ref = normalizedImageRef(block.attachment)
      const marker = ref
        ? imageMarker(ref, perceptionActive, perceptionEnabled)
        : '<dsh_media kind="image" state="invalid_attachment_ref" />'
      return [{ type: 'text', text: marker }]
    }
    if (block?.type === 'tool-result') {
      return [{ ...block, content: sanitizeBlocks(block.content, perceptionActive, perceptionEnabled) }]
    }
    return [block]
  })
}

export function sanitizeMessagesForTextModel(messages, perceptionActive, perceptionEnabled = true) {
  return asArray(messages).map((message) => {
    const content = sanitizeBlocks(message.content, perceptionActive, perceptionEnabled)
    return content.some((block, index) => block !== message.content[index])
      ? { ...message, content }
      : message
  })
}

export function hasDurableToolCall(events) {
  return asArray(events).some(event => event?.type === 'tool/call')
}

export function phaseSystem(events, config = {}) {
  if (typeof config.minimalSystem !== 'string') return undefined
  if (!hasDurableToolCall(events) || typeof config.contractSystem !== 'string'
    || config.contractSystem.length === 0) return config.minimalSystem
  return `${config.minimalSystem}\n\n${config.contractSystem}`
}

export function latestBridgeMeta(events, analysisId) {
  for (let index = asArray(events).length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/result') continue
    const meta = event.data?.meta?.[BRIDGE_META_KEY]
    if (!meta || typeof meta !== 'object') continue
    if (analysisId === undefined || meta.analysisId === analysisId) return meta
  }
  return undefined
}

function latestBridgeMetaEvent(events) {
  for (let index = asArray(events).length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const meta = event?.type === 'tool/result' ? event.data?.meta?.[BRIDGE_META_KEY] : undefined
    if (meta && typeof meta === 'object') return { event, meta }
  }
  return undefined
}

function sameMediaRefs(left, right) {
  const leftIds = asArray(left).map(ref => ref?.attachmentId)
  const rightIds = asArray(right).map(ref => ref?.attachmentId)
  return leftIds.length === rightIds.length
    && leftIds.every((id, index) => typeof id === 'string' && id === rightIds[index])
}

function mergeMediaRefs(...groups) {
  const merged = []
  const seen = new Set()
  for (const ref of groups.flatMap(group => asArray(group))) {
    if (typeof ref?.attachmentId !== 'string' || seen.has(ref.attachmentId)) continue
    seen.add(ref.attachmentId)
    merged.push(ref)
  }
  return merged
}

function bridgeResults(events, analysisId) {
  const results = []
  for (const event of asArray(events)) {
    if (event?.type !== 'tool/result') continue
    const meta = event.data?.meta?.[BRIDGE_META_KEY]
    if (meta?.analysisId !== analysisId) continue
    const nested = event.data?.message?.content?.[0]?.content
    for (const block of asArray(nested)) {
      if (block?.type !== 'text') continue
      const start = block.text.indexOf(RESULT_OPEN)
      const end = block.text.lastIndexOf(RESULT_CLOSE)
      if (start < 0 || end <= start) continue
      try {
        const value = JSON.parse(block.text.slice(start + RESULT_OPEN.length, end).trim())
        results.push({
          round: value.round,
          status: value.status,
          summary: value.summary,
          answer: value.answer,
          coverage: value.coverage,
          gaps: value.gaps,
        })
      } catch {}
    }
  }
  return results.slice(-3)
}

function messageFromSurfaceEvent(event) {
  if (event?.type === 'user/message') return event.data
  if (event?.type === 'tool/result') return event.data?.message
  return undefined
}

function dataWithSurfaceMessage(event, message) {
  return event.type === 'tool/result' ? { ...event.data, message } : message
}

function latestLoggedImageRefs(events) {
  for (let index = asArray(events).length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const refs = extractImageRefs(messageFromSurfaceEvent(event)?.content)
    if (refs.length > 0) return refs
  }
  return []
}

function activeForAgent(agent, pending) {
  if (!agent) return false
  if ((pending.get(agent) ?? []).length > 0) return true
  return latestBridgeMeta(agent.session?.events)?.status === 'needs_followup'
}

export function rewriteHistoricalImages(agent, perceptionEnabled = true) {
  const session = agent?.session
  if (!session || typeof session.append !== 'function') {
    return { rewritten: 0, latestRefs: [], lastImageSeq: -1 }
  }
  const nodes = Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : []
  let rewritten = 0
  let latestRefs = []
  let lastImageSeq = -1
  let previousVisibleHadImages = false
  for (const seq of nodes) {
    const event = session.events?.[seq]
    const message = event?.seq === seq ? messageFromSurfaceEvent(event) : undefined
    if (!message) {
      previousVisibleHadImages = false
      continue
    }
    const visibleRefs = extractImageRefs(message.content)
    if (visibleRefs.length > 0) {
      latestRefs = previousVisibleHadImages
        ? mergeMediaRefs(latestRefs, visibleRefs)
        : visibleRefs
      lastImageSeq = seq
      previousVisibleHadImages = true
    } else {
      previousVisibleHadImages = false
    }
    if (extractRawImageRefs(message.content).length === 0) continue
    const [replacement] = sanitizeMessagesForTextModel([message], perceptionEnabled, perceptionEnabled)
    session.append(event.type, dataWithSurfaceMessage(event, replacement), {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    rewritten += 1
  }
  return { rewritten, latestRefs, lastImageSeq }
}

function bootstrapNames(tools, config, mediaActive) {
  const shellTools = asArray(config.shellTools).length > 0 ? config.shellTools : ['bash', 'pwsh']
  const commonTools = asArray(config.commonTools).length > 0 ? config.commonTools : ['read']
  const available = new Set(tools.map(tool => tool.name))
  const shells = shellTools.filter(tool => available.has(tool))
  const missing = commonTools.filter(tool => !available.has(tool))
  if (shells.length !== 1 || missing.length > 0) {
    throw new Error(`${name}: expected one native shell and every common tool; shells=${JSON.stringify(shells)}, missing=${JSON.stringify(missing)}`)
  }
  return new Set([...commonTools, ...shells, ...(mediaActive ? [TOOL_NAME] : [])])
}

export function projectAssembly(assembled, events, config = {}, mediaActive = false) {
  const tools = asArray(assembled.tools)
  const perceptionActive = config.visionEnabled !== false && mediaActive
  if (config.holdThatBootstrap === true && !hasDurableToolCall(events)) {
    const selected = bootstrapNames(tools, config, perceptionActive)
    return { ...assembled, tools: tools.filter(tool => selected.has(tool.name)) }
  }
  return {
    ...assembled,
    tools: tools.filter(tool => tool.name !== TOOL_NAME || perceptionActive),
  }
}

function extensionFor(ref) {
  const byType = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }
  return byType[ref.mediaType] ?? extname(ref.name ?? '') ?? '.img'
}

async function materializeImages(ctx, refs, signal) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-multimodal-'))
  try {
    const media = []
    for (const [index, ref] of refs.entries()) {
      signal?.throwIfAborted?.()
      const stored = await ctx.attachments.readImage(ref, signal)
      const path = join(cwd, `media-${String(index + 1).padStart(2, '0')}${extensionFor(stored.ref)}`)
      await writeFile(path, stored.data, { flag: 'wx' })
      media.push({
        index,
        kind: 'image',
        path,
        mediaType: stored.ref.mediaType,
        width: stored.ref.width,
        height: stored.ref.height,
        name: stored.ref.name ?? '',
      })
    }
    return { cwd, media }
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }
}

function publicResult(value) {
  const { _bridge, ...visible } = value
  return visible
}

export function redactBackendValue(value, privateRoot) {
  if (typeof value === 'string') return value.split(privateRoot).join('<media-workdir>')
  if (Array.isArray(value)) return value.map(item => redactBackendValue(item, privateRoot))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, redactBackendValue(item, privateRoot)]))
  }
  return value
}

function renderResult(_args, value) {
  return [{
    type: 'text',
    text: `${RESULT_OPEN}\n${JSON.stringify(publicResult(value))}\n${RESULT_CLOSE}`,
  }]
}

function presentationMeta(_args, value) {
  return { [BRIDGE_META_KEY]: value._bridge }
}

function toolDefinition(ctx, state, config) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The exact visual question to resolve in this round.' },
        target: { type: 'string', enum: ['answer_query', 'exhaustive'], description: 'Use exhaustive only when the user requests all usable information.' },
        analysis_id: { type: 'string', description: 'Reuse the id from the previous result for follow-up rounds.' },
        focus: { type: 'string', description: 'Optional region, object, OCR area, or uncertainty to inspect.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderResult,
      presentationMeta,
    },
    timeoutMs: Number.isSafeInteger(config.timeoutMs) ? config.timeoutMs + 5_000 : 185_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error(`${TOOL_NAME} requires an agent-owned execution`)
      const events = agent.session?.events ?? []
      const requestedId = text(args.analysis_id, 160)
      const pendingRefs = state.pending.get(agent) ?? []
      // A newly attached image always opens a new analysis unless the model
      // explicitly names an older analysis. This prevents a stale unfinished
      // result from silently capturing the new media.
      const previous = requestedId
        ? latestBridgeMeta(events, requestedId)
        : (pendingRefs.length === 0 ? latestBridgeMeta(events) : undefined)
      const continuing = previous?.status === 'needs_followup'
      const analysisId = continuing
        ? previous.analysisId
        : `mm-${String(exec.callId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96) || Date.now()}`
      const refs = continuing
        ? asArray(previous.mediaRefs)
        : (pendingRefs.length > 0 ? pendingRefs : latestLoggedImageRefs(events))
      if (refs.length === 0) throw new Error('no image attachment is available for perception')
      if (refs.length > (config.maxImages ?? 8)) throw new Error(`image count exceeds limit ${config.maxImages ?? 8}`)

      const round = continuing && Number.isSafeInteger(previous.round) ? previous.round + 1 : 1
      const target = args.target === 'exhaustive' ? 'exhaustive' : 'answer_query'
      const request = {
        analysisId,
        round,
        target,
        question: text(args.question, 4_000),
        focus: text(args.focus, 2_000),
        mediaKinds: ['image'],
        previousResults: bridgeResults(events, analysisId),
      }
      if (!request.question) throw new Error('question must not be empty')

      const materialized = await materializeImages(ctx, refs, exec.signal)
      const outputPath = join(materialized.cwd, 'vision-result.json')
      try {
        const backendInput = {
          config,
          request,
          media: materialized.media,
          cwd: materialized.cwd,
          outputPath,
          schemaPath: config.schemaPath ?? SCHEMA_PATH,
          signal: exec.signal,
        }
        const raw = typeof config.backendRunner === 'function'
          ? await config.backendRunner(backendInput)
          : await runVisionBackend(backendInput)
        const bounded = enforceCompletionBoundary(
          redactBackendValue(raw, materialized.cwd),
          request,
          { maxRounds: config.maxRounds },
        )
        const backend = selectedBackend(config)
        state.pending.delete(agent)
        return {
          ...bounded,
          backend,
          _bridge: {
            version: 1,
            analysisId,
            status: bounded.status,
            round,
            backend,
            mediaRefs: refs,
          },
        }
      } finally {
        await rm(materialized.cwd, { recursive: true, force: true })
      }
    },
  }
}

export function apply(ctx, config = {}) {
  const visionEnabled = config.visionEnabled !== false
  const state = {
    pending: new WeakMap(),
  }
  const disposers = []
  if (typeof config.minimalSystem === 'string') {
    disposers.push(ctx.systemPrompt.section({
      name: 'dsv4-pro:phase-persona',
      order: 1,
      complete: true,
      text: context => phaseSystem(context.agent?.session?.events, config),
    }))
  }
  if (visionEnabled) disposers.push(ctx.tools.register(toolDefinition(ctx, state, config)))
  if (visionEnabled && config.readImageBridge === true) {
    disposers.push(applyReadImageBridge(ctx))
  }
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    state.pending.delete(agent)
  }))
  disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (config.sanitizeImages === false || decision.kind !== 'accept'
      || Object.hasOwn(decision, 'value')) return decision
    const content = decision.content ?? result.content
    const refs = extractRawImageRefs(content)
    if (refs.length === 0) return decision
    if (visionEnabled && exec.agent) {
      state.pending.set(exec.agent, mergeMediaRefs(state.pending.get(exec.agent), refs))
    }
    return { ...decision, content: sanitizeBlocks(content, visionEnabled, visionEnabled) }
  }))
  // Definition-owned finalizers run after post-execute. When vision is enabled,
  // observe their frozen output so the next prompt can expose perceive_media;
  // pre-step migration always removes raw image blocks before the request.
  disposers.push(ctx.on('tools/result', (exec, result) => {
    if (config.sanitizeImages === false || !visionEnabled || !exec.agent) return
    const refs = extractRawImageRefs(result.content)
    if (refs.length > 0) {
      state.pending.set(exec.agent, mergeMediaRefs(state.pending.get(exec.agent), refs))
    }
  }))
  disposers.push(ctx.on('agent/session-start', ({ agent }) => {
    if (config.migrateHistoricalImages === false || config.sanitizeImages === false) return
    const migration = rewriteHistoricalImages(agent, visionEnabled)
    if (migration.latestRefs.length === 0) return
    const latestResult = latestBridgeMetaEvent(agent.session?.events)
    const latestImageSettled = latestResult
      && latestResult.event.seq > migration.lastImageSeq
      && latestResult.meta.status !== 'needs_followup'
      && sameMediaRefs(latestResult.meta.mediaRefs, migration.latestRefs)
    if (visionEnabled && !latestImageSettled) {
      state.pending.set(agent, migration.latestRefs)
    }
  }))
  disposers.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!visionEnabled) return
    const refs = extractRawImageRefs(message.content)
    if (refs.length > 0) state.pending.set(agent, refs)
  }))
  disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (!agent) return assembled
    return projectAssembly(assembled, agent.session?.events, config, visionEnabled && activeForAgent(agent, state.pending))
  }))
  disposers.push(ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (config.migrateHistoricalImages !== false && config.sanitizeImages !== false) {
      const migration = rewriteHistoricalImages(agent, visionEnabled)
      if (visionEnabled && migration.rewritten > 0 && migration.latestRefs.length > 0) {
        state.pending.set(agent, mergeMediaRefs(state.pending.get(agent), migration.latestRefs))
      }
    }
    const decision = await next()
    if (decision.kind !== 'enter' || config.sanitizeImages === false) return decision
    const refs = decision.messages.flatMap(message => extractRawImageRefs(message.content))
    if (refs.length === 0) return decision
    if (visionEnabled) state.pending.set(agent, refs)
    return {
      ...decision,
      messages: sanitizeMessagesForTextModel(decision.messages, visionEnabled, visionEnabled),
    }
  }))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
