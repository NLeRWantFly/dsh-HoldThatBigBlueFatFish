import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  CONDITION_FACTS,
  MINIMAL_SYSTEM,
  OFFICIAL_BASE_URL,
  PRICING,
  ROUTE,
  shellTool,
} from './constants.mjs'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const EXPERIMENTS_ROOT = resolve(HERE, '..')
export const MODELTEST = resolve(process.env.DSH_EVAL_MODELTEST
  ?? join(EXPERIMENTS_ROOT, 'dsv4-first-action', 'project2', 'modeltest'))
export const PLATFORM = process.env.DSH_EVAL_PLATFORM ?? 'windows-native'
export const BASE_URL = process.env.DSH_EVAL_BASE_URL
  ?? (PLATFORM === 'linux-docker' ? 'http://127.0.0.1:3091' : 'http://127.0.0.1:3090')
export const SOURCE_ROOT = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
export const PRESET_ROOT = resolve(HERE, '..', '..', '.agent-presets')
export const PYTHON = process.env.DSH_EVAL_PYTHON
  ?? (process.platform === 'win32' ? 'python' : 'python3')
export const DOCKER_CONTAINER = process.env.DSH_EVAL_DOCKER_CONTAINER ?? 'dsv4-anchored-official-linux'

const execFileAsync = promisify(execFile)
const SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g
const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.txt', '.log', '.yml', '.yaml', '.mjs', '.js', '.ps1', '.py', '.csv'])

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}

export function canonicalJson(value, space = 0) {
  return JSON.stringify(stable(value), null, space) + (space ? '\n' : '')
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return createHash('sha256').update(bytes).digest('hex')
}

export async function sha256File(path) {
  return sha256(await readFile(path))
}

export function assertNoSuspectedSecret(value, label = 'artifact') {
  const text = typeof value === 'string' ? value : canonicalJson(value)
  const exact = process.env.DEEPSEEK_API_KEY
  if (exact && text.includes(exact)) throw new Error(`SECRET_DETECTED: ${label} contains the configured API key`)
  SECRET_PATTERN.lastIndex = 0
  if (SECRET_PATTERN.test(text)) throw new Error(`SECRET_DETECTED: ${label} contains a suspected API key`)
  if (/authorization["']?\s*[:=]\s*["']?bearer\s+[^\s"']+/i.test(text)) {
    throw new Error(`SECRET_DETECTED: ${label} contains an Authorization bearer value`)
  }
}

export async function writeTextSecure(path, text) {
  assertNoSuspectedSecret(text, path)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

export async function writeJson(path, value) {
  await writeTextSecure(path, canonicalJson(value, 2))
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function listFiles(root, { includeGit = false } = {}) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!includeGit && entry.name === '.git') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

export async function treeHash(root) {
  const rows = []
  for (const file of await listFiles(root)) {
    rows.push([relative(root, file).replaceAll('\\', '/'), await sha256File(file)])
  }
  return sha256(canonicalJson(rows))
}

export async function scanTreeForSecrets(root) {
  const exact = process.env.DEEPSEEK_API_KEY ? Buffer.from(process.env.DEEPSEEK_API_KEY) : undefined
  let scannedFiles = 0
  for (const file of await listFiles(root, { includeGit: true })) {
    const bytes = await readFile(file)
    scannedFiles++
    if (exact && bytes.includes(exact)) throw new Error(`SECRET_DETECTED: configured API key found in ${relative(root, file)}`)
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
    if (bytes.length <= 16 * 1024 * 1024 && TEXT_EXTENSIONS.has(extension)) {
      assertNoSuspectedSecret(bytes.toString('utf8'), relative(root, file))
    }
  }
  return { scannedFiles, exactCredentialConfigured: exact !== undefined, suspectedSecrets: 0 }
}

export async function execChecked(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  }).catch(error => {
    if (!options.allowFailure) throw error
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 }
}

export async function commandText(file, args, cwd = SOURCE_ROOT) {
  const result = await execChecked(file, args, { cwd, allowFailure: true })
  return `${result.stdout}${result.stderr}`.trim()
}

export async function rpc(method, payload, baseUrl = BASE_URL) {
  const rpcId = `dsv4-official-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  if (body?.result?.ok !== true) {
    const error = body?.result?.error
    throw new Error(`${method}: ${error?.code ?? 'RPC_ERROR'}: ${error?.message ?? JSON.stringify(body)}`)
  }
  return body.result.value
}

export async function history(sessionId) {
  const page = await rpc('session.history', { sessionId, maxMessages: 10000 })
  if (page.hasMore) throw new Error(`history page for ${sessionId} exceeded 10000 events`)
  return page.events.map(entry => entry.event)
}

export async function waitFor(sessionId, predicate, timeoutMs, label) {
  const started = Date.now()
  let events = []
  while (Date.now() - started < timeoutMs) {
    events = await history(sessionId)
    if (predicate(events)) return events
    await new Promise(resolveWait => setTimeout(resolveWait, 400))
  }
  throw new Error(`timed out waiting for ${label} in ${sessionId}; observed ${events.length} events`)
}

export async function runSession({ sessionId, title, cwd, preset, prompt, timeoutMs }) {
  await rpc('session.create', { sessionId, cwd, agentPreset: preset })
  await rpc('session.rename', { sessionId, title })
  const selection = await rpc('session.selectModel', { sessionId, ...ROUTE })
  if (canonicalJson(selection.selected) !== canonicalJson(ROUTE)) {
    throw new Error(`route mismatch: ${JSON.stringify(selection.selected)}`)
  }
  const sentAt = Date.now()
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    clientTimeZone: 'Asia/Shanghai',
    content: [{ type: 'text', text: prompt }],
  })
  const events = await waitFor(
    sessionId,
    observed => observed.some(event => event.type === 'turn/end'),
    timeoutMs,
    'turn/end',
  )
  return { sessionId, sentAt, events }
}

export function normalizeEvent(event) {
  return stable(event)
}

export async function writeEvents(path, events) {
  const text = events.map(event => JSON.stringify(normalizeEvent(event))).join('\n') + '\n'
  await writeTextSecure(path, text)
}

export async function readEvents(path) {
  const text = await readFile(path, 'utf8')
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

export function agentPath(path, platform = PLATFORM) {
  if (platform !== 'linux-docker') return resolve(path)
  const root = EXPERIMENTS_ROOT.replaceAll('\\', '/')
  const normalized = resolve(path).replaceAll('\\', '/')
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`Docker path is outside the mounted experiments root: ${path}`)
  }
  return `/experiments${normalized.slice(root.length)}`
}

function eventTime(event) {
  const value = event?.time ?? event?.createdAt ?? event?.timestamp
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function eventSeq(event, fallback) {
  return Number.isFinite(event?.seq) ? event.seq : fallback
}

export function messageContent(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  return Array.isArray(content) ? content : []
}

export function contentOf(event, type) {
  return messageContent(event).filter(block => block?.type === type)
}

export function callArguments(block) {
  const raw = block?.arguments ?? block?.input ?? block?.args
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return { raw }
    }
  }
  return raw ?? {}
}

export function toolName(block) {
  return String(block?.name ?? block?.toolName ?? block?.tool ?? '')
}

const STYLE_MARKERS = Object.freeze([
  ['let me', /\blet me\b/gi],
  ["let's", /\blet['’]s\b/gi],
  ['systematically', /\bsystematically\b/gi],
  ['explore', /\bexplor(?:e|ing|ation)\b/gi],
  ['先系统', /先系统/g],
  ['系统性', /系统性/g],
  ['先了解', /先了解/g],
  ['遍历', /遍历/g],
])

const ORCHESTRATION_TOOL = /^(todo_write|workflow|ralph|create_goal|update_goal|subagent)/
const BROAD_SHELL = /\b(?:rg\s+--files|git\s+ls-files|find\s+\.|ls\s+-[A-Za-z]*R|tree(?:\.exe)?|dir\s+\/s|get-childitem\b[^\r\n]*-recurse)\b/i

export function classifyBreadth(calls) {
  let broad = 0
  let orchestration = 0
  for (const block of calls) {
    const name = toolName(block)
    const args = callArguments(block)
    if (ORCHESTRATION_TOOL.test(name)) orchestration++
    if (name === 'glob') {
      const pattern = String(args.pattern ?? '').trim().replaceAll('\\', '/')
      const root = !args.path || args.path === '.'
      if (['*', '**', '**/*'].includes(pattern) || (root && (pattern.startsWith('**/') || !pattern.includes('/')))) broad++
    }
    if (name === 'grep' && (!args.path || args.path === '.')) broad++
    if ((name === 'bash' || name === 'pwsh') && BROAD_SHELL.test(String(args.command ?? ''))) broad++
    if (args.run_in_background === true) orchestration++
  }
  if (orchestration > 0 || calls.length >= 4) return 3
  if (broad > 0 || calls.length > 2) return 2
  if (calls.length > 0) return 1
  return 0
}

function currentHeaders(events) {
  let header
  const assistantHeaders = new Map()
  const headers = []
  events.forEach((event, index) => {
    if (event.type === 'request/header') {
      header = event.data?.header ?? {}
      headers.push({ event, header, seq: eventSeq(event, index) })
    }
    if (event.type === 'assistant/message') assistantHeaders.set(event, header)
  })
  return { assistantHeaders, headers }
}

function blockText(block) {
  return String(block?.text ?? block?.reasoning ?? '')
}

function usageOf(event) {
  return event?.data?.usage ?? event?.data?.message?.usage ?? {}
}

export function sumUsage(events) {
  const output = {}
  for (const event of events.filter(candidate => candidate.type === 'assistant/message')) {
    for (const [key, value] of Object.entries(usageOf(event))) {
      if (typeof value === 'number' && Number.isFinite(value)) output[key] = (output[key] ?? 0) + value
    }
  }
  return stable(output)
}

export function estimateCost(usage) {
  const cacheMiss = Number(usage.inputTokens ?? 0)
  const cacheHit = Number(usage.cacheReadTokens ?? 0)
  const output = Number(usage.outputTokens ?? 0)
  const usd = (
    cacheMiss * PRICING.cacheMissInput
    + cacheHit * PRICING.cacheHitInput
    + output * PRICING.output
  ) / PRICING.unitTokens
  return { currency: PRICING.currency, estimated: Number(usd.toFixed(8)), pricing: PRICING }
}

function assistantProjection(event, header, index) {
  const reasoningBlocks = contentOf(event, 'reasoning').map(blockText)
  const textBlocks = contentOf(event, 'text').map(blockText)
  const toolCalls = contentOf(event, 'tool-call').map(block => stable({
    id: block.id ?? null,
    name: toolName(block),
    arguments: callArguments(block),
  }))
  return stable({
    index: index + 1,
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
    seq: event.seq ?? null,
    headerSha256: sha256(canonicalJson(header ?? {})),
    system: String(header?.system ?? ''),
    systemSha256: sha256(String(header?.system ?? '')),
    toolSchemaSha256: sha256(canonicalJson(header?.tools ?? [])),
    toolNames: (header?.tools ?? []).map(tool => tool.name),
    reasoningBlocks,
    reasoning: reasoningBlocks.join('\n'),
    textBlocks,
    text: textBlocks.join('\n'),
    toolCalls,
    usage: usageOf(event),
  })
}

function runtimeContextCount(events) {
  return events.filter(event => event.type === 'user/message'
    && messageContent(event).some(block => block?.type === 'text'
      && String(block.text ?? '').startsWith('Current runtime context.'))).length
}

function firstStepTimings(events, sentAt) {
  const start = events.find(event => event.type === 'step/start' && event.data?.step === 1)
  const firstChunk = events.find(event => event.type === 'assistant/chunk' && event.data?.step === 1)
  const assistant = events.find(event => event.type === 'assistant/message' && event.data?.step === 1)
    ?? events.find(event => event.type === 'assistant/message')
  const startMs = eventTime(start) ?? sentAt
  const chunkMs = eventTime(firstChunk)
  const assistantMs = eventTime(assistant)
  return {
    ttftMs: Number.isFinite(chunkMs) && Number.isFinite(startMs) ? chunkMs - startMs : null,
    responseMs: Number.isFinite(assistantMs) && Number.isFinite(startMs) ? assistantMs - startMs : null,
  }
}

export function scoreTrajectory(sample, events) {
  const assistants = events.filter(event => event.type === 'assistant/message')
  if (assistants.length === 0) throw new Error(`${sample.id}: no assistant/message event`)
  const { assistantHeaders, headers } = currentHeaders(events)
  if (headers.length === 0) throw new Error(`${sample.id}: no request/header event`)
  const projected = assistants.map((event, index) => assistantProjection(event, assistantHeaders.get(event), index))
  const first = projected[0]
  const firstCalls = first.toolCalls
  const firstVisible = `${first.reasoning}\n${first.text}`
  const markerCounts = Object.fromEntries(STYLE_MARKERS.map(([label, expression]) => {
    expression.lastIndex = 0
    return [label, [...firstVisible.matchAll(expression)].length]
  }))
  const platform = sample.platform ?? PLATFORM
  const bootstrap = new Set(['read', shellTool(platform)])
  const firstToolCallEvent = events.find(event => event.type === 'tool/call')
  const firstToolCallSeq = firstToolCallEvent === undefined
    ? undefined
    : eventSeq(firstToolCallEvent, events.indexOf(firstToolCallEvent))
  const promotionHeader = firstToolCallSeq === undefined
    ? undefined
    : headers.find(record => record.seq > firstToolCallSeq && (record.header.tools?.length ?? 0) > 2)
  const laterCalls = projected.slice(1).flatMap(message => message.toolCalls)
  const outsideBootstrap = [...new Set(laterCalls.map(call => call.name).filter(name => !bootstrap.has(name)))]
  const usage = sumUsage(events)
  const allSystems = [...new Set(headers.map(record => String(record.header.system ?? '')))]
  const firstHeader = headers[0].header
  const terminal = events.findLast?.(event => event.type === 'turn/end')
    ?? [...events].reverse().find(event => event.type === 'turn/end')
  const firstToolEventSeq = firstToolCallEvent?.seq ?? null
  const firstAssistantSeq = assistants[0]?.seq ?? null
  const promotionHeaderSeq = promotionHeader?.event?.seq ?? null
  const secondAssistantSeq = assistants[1]?.seq ?? null

  return stable({
    id: sample.id,
    suite: sample.suite,
    platform,
    condition: sample.condition,
    repeat: sample.repeat,
    prompt: sample.prompt,
    promptSha256: sha256(sample.prompt),
    sessionId: sample.sessionId,
    eventFile: sample.eventFile,
    route: firstHeader.config ?? {},
    requestCount: assistants.length,
    requestHeaderCount: headers.length,
    firstHeaderSha256: sha256(canonicalJson(firstHeader)),
    firstSystem: String(firstHeader.system ?? ''),
    firstSystemSha256: sha256(String(firstHeader.system ?? '')),
    firstSystemChars: String(firstHeader.system ?? '').length,
    firstToolSchemaSha256: sha256(canonicalJson(firstHeader.tools ?? [])),
    firstToolNames: (firstHeader.tools ?? []).map(tool => tool.name),
    firstToolCount: (firstHeader.tools ?? []).length,
    firstReasoningChars: first.reasoning.length,
    firstTextChars: first.text.length,
    firstNarrationCharsBeforeAction: firstCalls.length > 0 ? first.reasoning.length + first.text.length : 0,
    markerCounts,
    firstToolCalls: firstCalls,
    firstToolCallCount: firstCalls.length,
    firstParallelFanout: firstCalls.length,
    firstBreadth: classifyBreadth(firstCalls),
    firstCompliant: classifyBreadth(firstCalls) <= 1 && firstCalls.length <= 2,
    runtimeContextMessages: runtimeContextCount(events),
    minimalSystemExact: allSystems.length === 1 && allSystems[0] === MINIMAL_SYSTEM,
    harnessIdentityPresent: allSystems.some(system => system.includes('You are a coding agent powered by')),
    allSystemSha256: allSystems.map(sha256),
    promotion: {
      durableToolCallSeen: firstToolCallEvent !== undefined,
      firstToolCallSeq: firstToolEventSeq,
      promotionHeaderSeq,
      promotedOnFollowingRequest: promotionHeader !== undefined
        && firstAssistantSeq !== null
        && firstToolEventSeq !== null
        && promotionHeaderSeq !== null
        && secondAssistantSeq !== null
        && firstAssistantSeq < firstToolEventSeq
        && firstToolEventSeq < promotionHeaderSeq
        && promotionHeaderSeq < secondAssistantSeq,
      promotedToolCount: promotionHeader?.header?.tools?.length ?? null,
      promotedToolSchemaSha256: promotionHeader === undefined ? null : sha256(canonicalJson(promotionHeader.header.tools ?? [])),
      systemStayedMinimal: CONDITION_FACTS[sample.condition]?.system !== 'minimal' || allSystems.every(system => system === MINIMAL_SYSTEM),
      outsideBootstrapToolsUsed: outsideBootstrap,
    },
    firstThree: projected.slice(0, 3),
    usage,
    cost: estimateCost(usage),
    ...firstStepTimings(events, sample.sentAt),
    turnEndReason: terminal?.data?.reason ?? null,
  })
}

export function extractCandidatePrompt(markdown) {
  const heading = markdown.indexOf('## 提示词正文')
  if (heading < 0) throw new Error('candidate prompt heading not found')
  const fence = markdown.indexOf('```text', heading)
  const end = markdown.indexOf('\n```', fence + 7)
  if (fence < 0 || end < 0) throw new Error('candidate prompt code fence not found')
  return markdown.slice(fence + 7, end).replace(/^\r?\n/, '')
}

export function manifestSafeName(path) {
  return basename(path).replace(/[\\/:*?"<>|]/g, '_')
}

export function releaseRank(value) {
  const letter = String(value ?? '').trim().toUpperCase().match(/\b(?:CLASS\s*)?([A-D])\b/)?.[1]
  return letter === undefined ? -1 : ({ A: 4, B: 3, C: 2, D: 1 })[letter]
}
