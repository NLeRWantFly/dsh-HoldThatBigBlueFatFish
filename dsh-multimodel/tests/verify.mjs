import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apply,
  BRIDGE_META_KEY,
  extractImageRefs,
  extractRawImageRefs,
  latestBridgeMeta,
  phaseSystem,
  projectAssembly,
  redactBackendValue,
  rewriteHistoricalImages,
  sanitizeMessagesForTextModel,
  TOOL_NAME,
} from '../src/multimodal-bridge.mjs'
import {
  buildCodexInvocation,
  buildClaudeInvocation,
  runVisionBackend,
  selectedBackend,
  spawnCapture,
} from '../src/backends.mjs'
import {
  enforceCompletionBoundary,
  parseBackendJson,
  requiredCoverage,
} from '../src/protocol.mjs'

let assertions = 0
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  assertions += 1
}
function ok(value, message) {
  assert.ok(value, message)
  assertions += 1
}

function resultFor(target, status = 'complete') {
  return {
    status,
    summary: 'Inspected the fixture.',
    answer: 'Fixture answer.',
    observations: [{
      claim: 'A visible fixture exists.',
      evidence: { media_index: 0, locator: 'entire image' },
      confidence: 0.98,
    }],
    coverage: requiredCoverage(target, ['image']).map(lane => ({
      lane,
      status: 'covered',
      note: `${lane} inspected`,
    })),
    uncertainties: [],
    gaps: [],
    suggested_followups: [],
    boundary_reason: 'All requested evidence is covered.',
  }
}

function bridgeEvent(args, definition, value, seq = 0) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          content: definition.output.render(args, value),
        }],
      },
      meta: definition.output.presentationMeta(args, value),
    },
  }
}

function imageToolMessage(ref, callId) {
  return {
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [
        { type: 'text', text: `<path>${ref.name}</path>\n<type>image</type>` },
        { type: 'image', attachment: ref },
      ],
      isError: false,
    }],
    id: `result-${callId}`,
  }
}

function surfaceSession(events, appends = []) {
  return {
    events: [...events],
    surface: { nodes: events.map(event => event.seq) },
    append(type, data, options = {}) {
      const event = { seq: this.events.length, type, data, ...options }
      this.events.push(event)
      if (options.surfaceOp === 'append') {
        this.surface.nodes.push(event.seq)
      } else if (options.surfaceOp?.op === 'replace') {
        const start = this.surface.nodes.indexOf(options.surfaceOp.start)
        const end = this.surface.nodes.indexOf(options.surfaceOp.end)
        if (start < 0 || end < start) throw new Error('invalid test surface replacement')
        this.surface.nodes.splice(start, end - start + 1, event.seq)
      }
      appends.push({ type, data, options })
      return event
    },
  }
}

class FakeContext {
  constructor() {
    this.listeners = new Map()
    this.definition = undefined
    this.tools = {
      register: (definition) => {
        this.definition = definition
        return () => { this.definition = undefined }
      },
    }
    this.attachments = {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    }
  }

  on(name, listener) {
    const group = this.listeners.get(name) ?? []
    group.push(listener)
    this.listeners.set(name, group)
    return () => {
      const index = group.indexOf(listener)
      if (index >= 0) group.splice(index, 1)
    }
  }

  listener(name) {
    const listener = this.listeners.get(name)?.[0]
    if (!listener) throw new Error(`missing listener ${name}`)
    return listener
  }
}

// Completion is host-enforced: a backend cannot self-certify over missing lanes.
const incomplete = resultFor('exhaustive')
incomplete.coverage = incomplete.coverage.filter(item => item.lane !== 'text_ocr')
const incompleteBounded = enforceCompletionBoundary(incomplete, {
  analysisId: 'mm-1', round: 1, target: 'exhaustive', mediaKinds: ['image'],
})
check(incompleteBounded.status, 'needs_followup')
ok(incompleteBounded.gaps.includes('coverage:text_ocr'))
const capped = enforceCompletionBoundary(incomplete, {
  analysisId: 'mm-1', round: 2, target: 'exhaustive', mediaKinds: ['image'],
}, { maxRounds: 2 })
check(capped.status, 'blocked')
const complete = enforceCompletionBoundary(resultFor('answer_query'), {
  analysisId: 'mm-2', round: 1, target: 'answer_query', mediaKinds: ['image'],
})
check(complete.status, 'complete')
check(complete.boundary.satisfied, true)
const uncertainRaw = resultFor('answer_query')
uncertainRaw.uncertainties = [{
  claim: 'Small text remains ambiguous.', severity: 'material', how_to_resolve: 'Inspect a tighter crop.',
}]
const uncertain = enforceCompletionBoundary(uncertainRaw, {
  analysisId: 'mm-3', round: 1, target: 'answer_query', mediaKinds: ['image'],
})
check(uncertain.status, 'needs_followup')
check(uncertain.suggested_followups, ['Inspect a tighter crop.'])

// Structured-output parsers accept direct Codex JSON and Claude wrappers.
check(parseBackendJson('{"status":"complete"}').status, 'complete')
check(parseBackendJson('{"structured_output":{"status":"blocked"}}').status, 'blocked')
check(parseBackendJson('```json\n{"status":"needs_followup"}\n```').status, 'needs_followup')

const ref = {
  attachmentId: 'sha256:test', mediaType: 'image/png', bytes: 4,
  width: 8, height: 6, name: 'fixture.png',
}
const secondRef = { ...ref, attachmentId: 'sha256:test-2', name: 'fixture-2.png' }
const nestedMessages = [{
  id: 'u1', role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: 'inspect' }, { type: 'image', attachment: ref }],
}]
check(extractImageRefs(nestedMessages[0].content), [ref])
check(extractRawImageRefs(nestedMessages[0].content), [ref])
const sanitized = sanitizeMessagesForTextModel(nestedMessages, true)
check(sanitized[0].content.some(block => block.type === 'image'), false)
ok(sanitized[0].content[1].text.includes('call perceive_media'))
check(extractImageRefs(sanitized[0].content), [ref], 'text marker must preserve a durable attachment reference')
check(JSON.stringify(sanitized).includes('image_url'), false)
check(nestedMessages[0].content[1].type, 'image', 'source message must remain unchanged')
const rawToolMessage = imageToolMessage(ref, 'call-read-image')
const sanitizedToolMessage = sanitizeMessagesForTextModel([rawToolMessage], true)[0]
check(extractRawImageRefs(rawToolMessage.content), [ref])
check(extractRawImageRefs(sanitizedToolMessage.content), [])
check(extractImageRefs(sanitizedToolMessage.content), [ref])
check(JSON.stringify(sanitizedToolMessage).includes('"type":"image"'), false)
check(redactBackendValue({ path: 'C:\\temp\\private\\x.png' }, 'C:\\temp\\private'), {
  path: '<media-workdir>\\x.png',
})

const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }, { name: TOOL_NAME }]
check(projectAssembly({ tools }, [], {
  holdThatBootstrap: true, shellTools: ['bash', 'pwsh'], commonTools: ['read'],
}, false).tools.map(tool => tool.name), ['bash', 'read'])
check(projectAssembly({ tools }, [], {
  holdThatBootstrap: true, shellTools: ['bash', 'pwsh'], commonTools: ['read'],
}, true).tools.map(tool => tool.name), ['bash', 'read', TOOL_NAME])
check(projectAssembly({ tools }, [{ type: 'tool/call' }], {}, false).tools.map(tool => tool.name), ['bash', 'read', 'edit'])
const minimalSystem = 'You are a helpful software engineer assistant.'
const contractSystem = 'Preserve protocol strings and verify required checks.'
check(phaseSystem([], { minimalSystem, contractSystem }), minimalSystem)
check(phaseSystem([{ type: 'tool/call' }], { minimalSystem, contractSystem }), `${minimalSystem}\n\n${contractSystem}`)
check(phaseSystem([{ type: 'tool/call' }], {}), undefined)

// Invocation construction inherits cc-switch configuration unless an override is explicit.
check(selectedBackend({}, { DSH_VISION_BACKEND: 'claude' }), 'claude')
const codexInvocation = buildCodexInvocation({ codex: { command: 'codex' } }, [{ path: 'x.png' }], 'prompt', {
  schema: 'schema.json', output: 'out.json', cwd: 'tmp',
})
check(codexInvocation.command, 'codex')
ok(codexInvocation.args.includes('--image'))
check(codexInvocation.args.at(-2), '--')
check(codexInvocation.args.at(-1), 'prompt')
check(codexInvocation.args.some(arg => /api[_-]?key|auth[_-]?token/i.test(arg)), false)
check(buildCodexInvocation({ codex: {} }, [], 'prompt', {
  schema: 'schema.json', output: 'out.json', cwd: 'tmp',
}).command, process.platform === 'win32' ? 'codex.exe' : 'codex')
const claudeInvocation = buildClaudeInvocation({ claude: { command: 'claude' } }, [{ path: 'x.png' }], 'prompt', '{}')
check(claudeInvocation.command, 'claude')
ok(claudeInvocation.args.includes('--bare'))
ok(claudeInvocation.args.includes('Read'))

// Real subprocess round-trips through fake Codex and Claude CLIs.
const runDir = await mkdtemp(join(tmpdir(), 'dsh-mm-test-'))
const fakeCli = fileURLToPath(new URL('./fake-vision-cli.mjs', import.meta.url))
const schemaPath = fileURLToPath(new URL('../schemas/vision-result.schema.json', import.meta.url))
const mediaPath = join(runDir, 'media.png')
await writeFile(mediaPath, new Uint8Array([1, 2, 3]))
const backendInput = {
  request: {
    analysisId: 'mm-cli', round: 1, target: 'answer_query', question: 'fixture?',
    mediaKinds: ['image'], previousResults: [],
  },
  media: [{ index: 0, kind: 'image', path: mediaPath, mediaType: 'image/png', width: 1, height: 1, name: 'media.png' }],
  cwd: runDir,
  outputPath: join(runDir, 'out.json'),
  schemaPath,
  signal: new AbortController().signal,
}
try {
  const codexResult = await runVisionBackend({
    ...backendInput,
    config: { backend: 'codex', codex: { command: process.execPath, commandArgs: [fakeCli, 'codex'] } },
  })
  check(codexResult.answer, 'Synthetic visual answer.')
  const claudeResult = await runVisionBackend({
    ...backendInput,
    config: { backend: 'claude', claude: { command: process.execPath, commandArgs: [fakeCli, 'claude'] } },
  })
  check(claudeResult.answer, 'Synthetic visual answer.')
  await assert.rejects(
    spawnCapture(process.execPath, [fakeCli, 'hang'], { cwd: runDir, timeoutMs: 50 }),
    /timed out after 50ms/,
  )
  assertions += 1
} finally {
  await rm(runDir, { recursive: true, force: true })
}

// Plugin-level two-round flow, including durable metadata reconstruction.
const ctx = new FakeContext()
let backendCalls = 0
let previousResultsSeen = 0
let materializedPath
const dispose = apply(ctx, {
  backend: 'codex',
  holdThatBootstrap: true,
  maxRounds: 4,
  backendRunner: async (input) => {
    backendCalls += 1
    previousResultsSeen = input.request.previousResults.length
    materializedPath = input.media[0].path
    await stat(materializedPath)
    if (input.request.round === 1) {
      const raw = resultFor('exhaustive', 'needs_followup')
      raw.coverage = raw.coverage.filter(item => item.lane !== 'text_ocr')
      raw.gaps = ['OCR detail remains.']
      raw.suggested_followups = ['Read the small text.']
      return raw
    }
    return resultFor('exhaustive')
  },
})
check(ctx.definition.output.schema, { type: 'object', additionalProperties: true })
check(ctx.listeners.has('llm/stream'), false, 'the plugin must not mutate frozen llm/stream requests')
const agent = { id: 'session-vision', session: { events: [] } }
ctx.listener('agent/inbox/inserted')({ agent, message: nestedMessages[0] })
const assembly = await ctx.listener('system-prompt/assemble')({}, { agent }, async () => ({ tools }))
check(assembly.tools.map(tool => tool.name), ['bash', 'read', TOOL_NAME])

const preStep = await ctx.listener('agent/pre-step')({ agent }, async () => ({
  kind: 'enter', messages: nestedMessages,
}))
check(preStep.messages[0].content.some(block => block.type === 'image'), false)
check(JSON.stringify(preStep.messages).includes('image_url'), false)
check(extractImageRefs(preStep.messages[0].content), [ref])
check(nestedMessages[0].content[1].type, 'image', 'pre-step must not mutate the claimed frozen batch')

// Tool-produced image blocks are sanitized before the durable tool/result is
// appended, and activate perception for the next system-prompt assembly.
const toolResultAgent = { id: 'tool-result-live', session: { events: [] } }
const rawToolContent = rawToolMessage.content[0].content
const postDecision = await ctx.listener('tools/post-execute')(
  { agent: toolResultAgent, name: 'read_image', callId: 'call-read-image' },
  { isError: false, content: rawToolContent },
  async () => ({ kind: 'accept' }),
)
check(postDecision.kind, 'accept')
check(extractRawImageRefs(postDecision.content), [])
check(extractImageRefs(postDecision.content), [ref])
check(extractRawImageRefs(rawToolContent), [ref], 'post-execute must not mutate the settled source result')
const postAssembly = await ctx.listener('system-prompt/assemble')(
  {}, { agent: toolResultAgent }, async () => ({ tools }),
)
check(postAssembly.tools.map(tool => tool.name), ['bash', 'read', TOOL_NAME])

// A resumed session can contain the image block that caused the provider 400.
// Replace that visible surface node before the first request and retain a
// marker from which AttachmentStore input can be reconstructed.
const historicalAppends = []
const historicalSession = surfaceSession([
  { seq: 0, type: 'user/message', data: nestedMessages[0] },
], historicalAppends)
const historicalAgent = { id: 'resumed-console-go', session: historicalSession }
const migration = rewriteHistoricalImages(historicalAgent)
check(migration.rewritten, 1)
check(migration.latestRefs, [ref])
check(historicalAppends[0].type, 'user/message')
check(historicalAppends[0].options, {
  surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0],
})
check(historicalAppends[0].data.content.some(block => block.type === 'image'), false)
check(extractImageRefs(historicalAppends[0].data.content), [ref])
check(rewriteHistoricalImages(historicalAgent).rewritten, 0, 'migration must be idempotent')

// Exact Console Go regression: two parallel read_image results were visible at
// step 99, then the step-100 request serialized one as messages[203].image_url.
const historicalToolAppends = []
const historicalToolSession = surfaceSession([
  {
    seq: 0, type: 'tool/result',
    data: { turn: 1, step: 99, message: imageToolMessage(ref, 'call-00') },
  },
  {
    seq: 1, type: 'tool/result',
    data: { turn: 1, step: 99, message: imageToolMessage(secondRef, 'call-01') },
  },
], historicalToolAppends)
const historicalToolAgent = { id: 'resumed-console-go-tool-results', session: historicalToolSession }
const toolMigration = rewriteHistoricalImages(historicalToolAgent)
check(toolMigration.rewritten, 2)
check(toolMigration.latestRefs, [ref, secondRef])
check(historicalToolAppends.map(item => item.type), ['tool/result', 'tool/result'])
check(historicalToolAppends.map(item => [item.data.turn, item.data.step]), [[1, 99], [1, 99]])
check(historicalToolSession.surface.nodes.map(seq => (
  extractRawImageRefs(historicalToolSession.events[seq].data.message.content).length
)), [0, 0])
check(historicalToolSession.surface.nodes.flatMap(seq => (
  extractImageRefs(historicalToolSession.events[seq].data.message.content)
)), [ref, secondRef])
check(rewriteHistoricalImages(historicalToolAgent).rewritten, 0, 'tool-result migration must be idempotent')

const resumedAppends = []
const resumedSession = surfaceSession([
  { seq: 0, type: 'user/message', data: nestedMessages[0] },
], resumedAppends)
const resumedAgent = { id: 'resumed-listener', session: resumedSession }
ctx.listener('agent/session-start')({ agent: resumedAgent, source: 'resume' })
check(resumedAppends.length, 1)
const resumedAssembly = await ctx.listener('system-prompt/assemble')({}, { agent: resumedAgent }, async () => ({ tools }))
check(resumedAssembly.tools.map(tool => tool.name), ['bash', 'read', TOOL_NAME])

const firstArgs = { question: 'Extract everything.', target: 'exhaustive' }
const first = await ctx.definition.execute(firstArgs, {
  agent, callId: 'call-1', signal: new AbortController().signal,
})
check(first.status, 'needs_followup')
check(first.round, 1)
await assert.rejects(access(materializedPath))
assertions += 1
agent.session.events.push(bridgeEvent(firstArgs, ctx.definition, first))
check(latestBridgeMeta(agent.session.events).analysisId, first.analysis_id)

const secondArgs = {
  analysis_id: first.analysis_id,
  question: 'Read the small text.',
  target: 'exhaustive',
  focus: 'small text',
}
const second = await ctx.definition.execute(secondArgs, {
  agent, callId: 'call-2', signal: new AbortController().signal,
})
check(second.status, 'complete')
check(second.round, 2)
check(previousResultsSeen, 1)
check(backendCalls, 2)
check(Object.hasOwn(JSON.parse(ctx.definition.output.render(secondArgs, second)[0].text
  .replace('<dsh_multimodal_result>\n', '')
  .replace('\n</dsh_multimodal_result>', '')), '_bridge'), false)
check(ctx.definition.output.presentationMeta(secondArgs, second)[BRIDGE_META_KEY].mediaRefs, [ref])

// New media supersedes a stale unfinished analysis when no id is requested.
const stale = { ...first, analysis_id: 'mm-stale', _bridge: { ...first._bridge, analysisId: 'mm-stale' } }
agent.session.events.push(bridgeEvent(firstArgs, ctx.definition, stale, 1))
const newRef = { ...ref, attachmentId: 'sha256:new', name: 'new.png' }
ctx.listener('agent/inbox/inserted')({
  agent,
  message: { ...nestedMessages[0], id: 'u2', content: [{ type: 'image', attachment: newRef }] },
})
const replacement = await ctx.definition.execute(firstArgs, {
  agent, callId: 'call-3', signal: new AbortController().signal,
})
ok(replacement.analysis_id !== 'mm-stale')
check(replacement._bridge.mediaRefs, [newRef])

dispose()
check(ctx.definition, undefined)

// Ensure schema is valid JSON as packaged.
const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
check(schema.type, 'object')
console.log(`MODIFIED PASS: assertions=${assertions} branches=mediaActive,completionBoundary backends=codex,claude subprocess=fake`)
