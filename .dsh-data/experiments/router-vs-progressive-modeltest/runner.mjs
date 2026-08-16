#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2] ?? 'live'
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT
  ?? join(homedir(), 'Documents', 'Codex', '2026-08-13', 'ba', 'work', 'deepseek-harness'))
const dshHome = resolve(process.env.DSH_HOME ?? join(sourceRoot, '.dsh-data'))
const comparisonWorkspace = resolve(process.env.COMPARISON_WORKSPACE
  ?? join(here, '..', '..', '..', '..', 'deepseek-harness'))
const modeltestSource = resolve(process.env.MODELTEST_SOURCE
  ?? join(comparisonWorkspace, 'modeltest'))
const routerSource = resolve(process.env.ROUTER_SOURCE
  ?? join(comparisonWorkspace, 'dsh-router-standard'))
const progressiveSource = resolve(process.env.PROGRESSIVE_SOURCE
  ?? join(here, '..', 'dsv4-anchored-v2-efficient', 'production'))
const anchoredSource = resolve(process.env.ANCHORED_96_SOURCE
  ?? join(here, '..', 'dsv4-pro-anchored-96'))
const contractAnchorSource = resolve(process.env.CONTRACT_ANCHOR_SOURCE
  ?? join(here, '..', 'dsv4-pro-contract-anchor'))
const espIdfActivationScript = process.env.DSH_EVAL_ESP_IDF_ACTIVATION_SCRIPT === undefined
  ? undefined
  : resolve(process.env.DSH_EVAL_ESP_IDF_ACTIVATION_SCRIPT)
const python = resolve(process.env.DSH_EVAL_PYTHON
  ?? join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'))
const route = Object.freeze({
  provider: process.env.DSH_EVAL_PROVIDER ?? 'deepseek-official',
  model: process.env.DSH_EVAL_MODEL ?? 'deepseek-v4-pro',
  reasoningEffort: process.env.DSH_EVAL_REASONING_EFFORT ?? 'max',
})
const credentialRef = process.env.DSH_EVAL_CREDENTIAL_REF
  ?? (route.provider === 'opencode-go' ? 'OPENCODE_GO_API_KEY' : 'DEEPSEEK_API_KEY')
const endpointProduct = process.env.DSH_EVAL_ENDPOINT_PRODUCT
  ?? (route.provider === 'opencode-go' ? 'opencode-go-subscription' : 'deepseek-api')
const endpointLabel = process.env.DSH_EVAL_ENDPOINT
  ?? (route.provider === 'opencode-go' ? 'opencode-go' : 'https://api.deepseek.com')
const conditions = Object.freeze([
  { id: 'router-standard', preset: 'dsh-router-standard', harness: 'dsh-router-standard' },
  { id: 'progressive-guarded', preset: 'dsv4-progressive-guarded', harness: 'dsh-progressive-guarded-v0.2' },
  { id: 'pro-anchored-96', preset: 'dsv4-pro-anchored-96', harness: 'dsh-pro-anchored-96' },
  { id: 'pro-contract-anchor', preset: 'dsv4-pro-contract-anchor', harness: 'dsh-pro-contract-anchor-v0.3' },
])
function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const requestLimit = positiveIntegerEnv('DSH_EVAL_REQUEST_LIMIT', 320)
const outputTokenLimit = positiveIntegerEnv('DSH_EVAL_OUTPUT_TOKEN_LIMIT', 384_000)
const timeoutMs = positiveIntegerEnv('DSH_EVAL_TIMEOUT_MS', 4 * 60 * 60 * 1000)
const skipEvaluator = process.env.DSH_EVAL_SKIP_EVALUATOR === '1'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

function extractPrompt(markdown) {
  const match = markdown.match(/```text\s*\r?\n([\s\S]*?)\r?\n```/)
  if (!match) throw new Error('CANDIDATE_PROMPT.md has no text fence')
  return match[1]
}

async function credentialDocumentExists() {
  const path = join(dshHome, '.credentials.yaml')
  return exists(path)
}

async function resultDirectories(modeltest) {
  const root = join(modeltest, 'evaluator', 'results')
  if (!(await exists(root))) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

async function cleanModeltest(control) {
  await mkdir(dirname(control), { recursive: true })
  const cloned = await execChecked('git', ['clone', '--local', '--no-hardlinks', '--no-tags', modeltestSource, control], {
    cwd: dirname(control),
  })
  if (cloned.code !== 0) throw new Error(`modeltest clone failed: ${cloned.stderr}`)
  const commit = await gitHead(control)
  const sourceCommit = await gitHead(modeltestSource)
  if (commit !== sourceCommit) throw new Error(`modeltest commit mismatch: ${commit} != ${sourceCommit}`)
  return commit
}

async function gitHead(repository) {
  return (await execChecked('git', ['-c', `safe.directory=${repository}`, 'rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
}

async function prepareHandoff(condition, control, runtimeRoot) {
  await execChecked(python, [join(control, 'evaluator', 'make_broken_project.py')], { cwd: control })
  const gitignore = join(control, 'workspace', 'project2_task', '.gitignore')
  const ignoreText = await readFile(gitignore, 'utf8')
  if (ignoreText.includes('\r\n')) await writeFile(gitignore, ignoreText.replaceAll('\r\n', '\n'), 'utf8')
  const output = join(runtimeRoot, condition.id, 'workspace')
  await mkdir(dirname(output), { recursive: true })
  await execChecked(python, [
    join(control, 'evaluator', 'prepare_candidate_handoff.py'),
    '--source', join(control, 'workspace'),
    '--output', output,
  ], { cwd: control })
  return output
}

function assistantCount(events) {
  return events.filter(event => event.type === 'assistant/message').length
}

function toolCallCount(events) {
  return events.filter(event => event.type === 'tool/call').length
}

function outputTokens(events) {
  return events
    .filter(event => event.type === 'assistant/message')
    .reduce((sum, event) => sum + Number(event.data?.usage?.outputTokens ?? event.data?.message?.usage?.outputTokens ?? 0), 0)
}

async function runSession({ rpc, history, condition, cwd, prompt, runId }) {
  const sessionId = `router-compare-${condition.id}-${runId}`
  await rpc('session.create', { sessionId, cwd, agentPreset: condition.preset })
  await rpc('session.rename', { sessionId, title: `Modeltest ${condition.id} ${route.provider} ${route.reasoningEffort}` })
  const selection = await rpc('session.selectModel', { sessionId, ...route })
  if (selection.selected?.provider !== route.provider
    || selection.selected?.model !== route.model
    || selection.selected?.reasoningEffort !== route.reasoningEffort) {
    throw new Error(`${condition.id}: route mismatch ${JSON.stringify(selection.selected)}`)
  }
  const sentAt = Date.now()
  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    clientTimeZone: 'Asia/Shanghai',
    content: [{ type: 'text', text: prompt }],
  })

  let lastAssistants = -1
  let lastCalls = -1
  let events = []
  let budgetStop = null
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    events = await history(sessionId)
    const assistants = assistantCount(events)
    const calls = toolCallCount(events)
    if (assistants !== lastAssistants || calls !== lastCalls) {
      lastAssistants = assistants
      lastCalls = calls
      process.stdout.write(`[progress] ${condition.id} assistants=${assistants} tools=${calls} outputTokens=${outputTokens(events)}\n`)
    }
    if (events.some(event => event.type === 'turn/end')) break
    if (assistants >= requestLimit || outputTokens(events) >= outputTokenLimit) {
      budgetStop = assistants >= requestLimit ? `request-limit-${requestLimit}` : `output-token-limit-${outputTokenLimit}`
      await rpc('session.cancel', { sessionId })
      const cancelledAt = Date.now()
      while (Date.now() - cancelledAt < 30_000) {
        events = await history(sessionId)
        if (events.some(event => event.type === 'turn/end')) break
        await new Promise(resolveWait => setTimeout(resolveWait, 400))
      }
      break
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000))
  }
  if (!events.some(event => event.type === 'turn/end')) {
    await rpc('session.cancel', { sessionId }).catch(() => undefined)
    throw new Error(`${condition.id}: timed out without turn/end`)
  }
  return { sessionId, sentAt, events, budgetStop }
}

function toolSummary(events) {
  const calls = events.filter(event => event.type === 'tool/call')
  const byName = {}
  for (const event of calls) {
    const name = event.data?.name ?? 'unknown'
    byName[name] = (byName[name] ?? 0) + 1
  }
  const denials = events.filter(event => event.type === 'tool/result')
    .filter(event => /PROGRESSIVE_|DENIED|BLOCKED|EXCEEDED/.test(JSON.stringify(event.data ?? {})))
  return { total: calls.length, byName, guardDenials: denials.length }
}

function cacheSummary(usage) {
  const hit = Number(usage.cacheReadTokens ?? 0)
  const miss = Number(usage.inputTokens ?? 0)
  const total = hit + miss
  return {
    cacheHitInputTokens: hit,
    cacheMissInputTokens: miss,
    totalInputTokens: total,
    hitRate: total === 0 ? null : Number((hit / total).toFixed(6)),
  }
}

async function evaluate({ condition, control, candidateProject, runDir, score, index }) {
  const before = new Set(await resultDirectories(control))
  const conditionDir = join(runDir, 'conditions', condition.id)
  // Keep this path short on Windows: ESP-IDF/Ninja still encounters MAX_PATH
  // edges in deeply nested per-run result directories.
  const evaluatorKey = createHash('sha256')
    .update(`${basename(runDir)}\0${condition.id}`)
    .digest('hex')
    .slice(0, 12)
  const evaluatorBuildRoot = join(comparisonWorkspace, '.espidf-eval', evaluatorKey)
  await mkdir(evaluatorBuildRoot, { recursive: true })
  const metaExtra = join(conditionDir, 'meta-extra.json')
  await writeJson(metaExtra, {
    condition: condition.id,
    provider_requests: score.requestCount,
    token_usage: score.usage,
    cache: cacheSummary(score.usage),
    estimated_cost_usd: score.cost.estimated,
    completed: score.completed,
    terminal_reason: score.turnEndReason,
  })
  const result = await execChecked(python, [
    join(control, 'evaluator', 'run_full_eval.py'), candidateProject,
    '--model', route.model,
    '--channel', route.provider,
    '--harness', condition.harness,
    '--require-meta',
    '--include-espidf-build',
    '--run-group-id', `progressive-production-win-${route.provider}-${route.reasoningEffort}`,
    '--run-index', String(index + 1),
    '--thinking-level', route.reasoningEffort,
    '--provider', route.provider,
    '--endpoint-product', endpointProduct,
    '--meta-extra', metaExtra,
  ], {
    cwd: control,
    allowFailure: true,
    env: { ...process.env, ESP_IDF_BUILD_ROOT: evaluatorBuildRoot },
  })
  await writeFile(join(conditionDir, 'evaluator.stdout.log'), result.stdout, 'utf8')
  await writeFile(join(conditionDir, 'evaluator.stderr.log'), result.stderr, 'utf8')
  const created = (await resultDirectories(control)).filter(name => !before.has(name))
  if (created.length !== 1) throw new Error(`${condition.id}: evaluator created ${created.length} result directories`)
  const source = join(control, 'evaluator', 'results', created[0])
  const target = join(conditionDir, 'official')
  await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  const summary = await readJson(join(target, 'summary.json'))
  const draft = await readJson(join(target, 'score_draft.json'))
  const blockers = await readJson(join(target, 'blockers.json'))
  return {
    id: condition.id,
    evaluatorExitCode: result.code,
    benchmark: summary.benchmark,
    ability: draft.ability_draft ?? summary.ability_draft,
    ship: draft.ship_draft ?? summary.ship_draft,
    releaseClass: draft.release_class_hint ?? summary.release_class_hint,
    blockers: blockers.final ?? summary.blockers ?? [],
    behaviorBlockers: blockers.behavior_blockers ?? summary.behavior_blockers ?? [],
    family: draft.family_draft ?? summary.family_draft ?? {},
    dimensions: summary.dimensions ?? {},
    durationSec: summary.duration_sec ?? null,
    censored: score.completed !== true,
    resultDir: relative(runDir, target).replaceAll('\\', '/'),
  }
}

async function buildRuntime({ port, runDir }) {
  const baseUrl = `http://127.0.0.1:${port}`
  let stderr = ''
  let stdout = ''
  const childEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  const pathKey = Object.keys(childEnv).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  childEnv[pathKey] = [dirname(python), childEnv[pathKey]].filter(Boolean).join(delimiter)
  const child = spawn(process.execPath, [join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: sourceRoot,
    windowsHide: true,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-1_000_000) })
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-1_000_000) })

  async function rpc(method, payload) {
    const response = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}-${Math.random()}`, method, payload }),
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok || body?.result?.ok !== true) {
      throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
    }
    return body.result.value
  }

  async function history(sessionId) {
    const page = await rpc('session.history', { sessionId, maxMessages: 10000 })
    if (page.hasMore) throw new Error(`${sessionId}: history exceeds 10000 events`)
    return page.events.map(entry => entry.event)
  }

  const readyAt = Date.now()
  while (true) {
    if (child.exitCode !== null) throw new Error(`DSH exited ${child.exitCode}: ${stderr}`)
    const ready = await fetch(`${baseUrl}/api/session.history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'ready', method: 'session.history', payload: { sessionId: 'missing', maxMessages: 1 } }),
    }).then(async response => (await response.json())?.result !== undefined).catch(() => false)
    if (ready) break
    if (Date.now() - readyAt > 60_000) throw new Error(`DSH readiness timeout: ${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }

  const credential = await rpc('credentials.describe', { refs: [credentialRef] })
  if (credential?.credentials?.[credentialRef]?.configured !== true) {
    throw new Error(`${credentialRef} is not configured in the DSH credential service`)
  }
  const presets = await rpc('agentPreset.list', {}).catch(() => null)

  class ApprovalDriver {
    async start() {
      const url = new URL('/api/events.mux', baseUrl)
      url.protocol = 'ws:'
      this.socket = new WebSocket(url)
      await new Promise((resolveReady, rejectReady) => {
        this.socket.addEventListener('open', resolveReady, { once: true })
        this.socket.addEventListener('error', () => rejectReady(new Error('approval websocket failed')), { once: true })
      })
      this.socket.addEventListener('message', event => void this.handle(event))
    }
    async handle(event) {
      try {
        if (typeof event.data !== 'string') return
        const envelope = JSON.parse(event.data)
        const request = envelope?.payload
        if (envelope?.type !== 'server-request' || request?.type !== 'approval/requested') return
        if (!String(request.sessionId ?? '').startsWith('router-compare-')) return
        const allowed = request.toolName === 'pwsh'
          && /escalate sandbox to (?:workspace-write|danger-full-access)/i.test(String(request.reason ?? ''))
        await fetch(new URL('/api/respond', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-response',
            rpcId: envelope.rpcId,
            result: { ok: true, value: { sessionId: request.sessionId, approvalId: request.approvalId, outcome: allowed ? 'allowed-once' : 'rejected' } },
          }),
        })
      } catch { /* a rejected/closed approval is reflected in session events */ }
    }
    close() { this.socket?.close(1000, 'complete') }
  }

  const approval = new ApprovalDriver()
  await approval.start()
  return {
    baseUrl,
    rpc,
    history,
    presets,
    close: async () => {
      approval.close()
      child.kill('SIGTERM')
      if (child.exitCode === null) {
        await new Promise(resolveExit => child.once('exit', resolveExit)).catch(() => undefined)
      }
      const redact = text => text.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
      await writeFile(join(runDir, 'host.stdout.log'), redact(stdout), 'utf8')
      await writeFile(join(runDir, 'host.stderr.log'), redact(stderr), 'utf8')
    },
  }
}

async function live() {
  if (!(await credentialDocumentExists())) throw new Error('The configured DSH credential document is absent')
  for (const path of [sourceRoot, modeltestSource, routerSource, progressiveSource, anchoredSource, contractAnchorSource, python, espIdfActivationScript].filter(Boolean)) {
    if (!(await exists(path))) throw new Error(`required path missing: ${path}`)
  }
  const requestedCondition = option('--condition')
  const selectedConditions = requestedCondition === undefined
    ? [...conditions]
    : conditions.filter(condition => condition.id === requestedCondition)
  if (selectedConditions.length === 0) throw new Error(`unknown condition: ${requestedCondition}`)
  for (const condition of selectedConditions) {
    if (!(await exists(join(dshHome, '.agent-presets', condition.preset, 'agent.cordis.yml')))) {
      throw new Error(`preset is not installed: ${condition.preset}`)
    }
  }

  const runId = `run-win-${stamp()}`
  const runDir = join(here, 'runs', runId)
  const runtimeRoot = resolve(join(here, '..', '..', '..', '.project2-handoffs', 'router-compare', runId))
  const control = join(runtimeRoot, 'modeltest-control')
  await mkdir(runDir, { recursive: true })
  const modeltestCommit = await cleanModeltest(control)
  const prompt = extractPrompt(await readFile(join(control, 'CANDIDATE_PROMPT.md'), 'utf8'))
  const port = await freePort()

  process.env.DSH_EVAL_BASE_URL = `http://127.0.0.1:${port}`
  process.env.DSH_EVAL_PLATFORM = 'windows-native'
  process.env.DSH_SOURCE_ROOT = sourceRoot
  process.env.DSH_EVAL_MODELTEST = control
  process.env.DSH_EVAL_PYTHON = python
  if (espIdfActivationScript !== undefined) process.env.ESP_IDF_ACTIVATION_SCRIPT = espIdfActivationScript
  const lib = await import('../dsv4-anchored-official/lib.mjs')

  const manifest = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    order: selectedConditions.map(condition => condition.id),
    route,
    endpoint: endpointLabel,
    endpointProduct,
    platform: 'windows-native',
    tokenBudget: { requestLimitPerCondition: requestLimit, outputTokenLimitPerCondition: outputTokenLimit },
    skipEvaluator,
    credentials: { source: 'DSH credential service', valueInspected: false, persisted: false },
    espIdf: espIdfActivationScript === undefined ? null : {
      backend: 'docker-activation',
      activationScript: relative(comparisonWorkspace, espIdfActivationScript).replaceAll('\\', '/'),
      image: process.env.DSV4_ESP_IDF_DOCKER_IMAGE ?? 'espressif/idf:v6.0.1',
      evaluatorBuildIsolation: 'short-per-condition-run-directory',
    },
    commits: {
      modeltest: modeltestCommit,
      router: await gitHead(routerSource),
      progressive: await gitHead(resolve(here, '..', '..', '..')),
      dsh: await gitHead(sourceRoot),
    },
    hashes: {
      prompt: lib.sha256(prompt),
      routerBootstrap: await lib.sha256File(join(routerSource, 'preset', 'router-bootstrap.mjs')),
      routerCore: await lib.sha256File(join(routerSource, 'preset', 'router-core.mjs')),
      progressiveGuard: await lib.sha256File(join(progressiveSource, 'progressive-guard.mjs')),
      anchored96: await lib.sha256File(join(anchoredSource, 'anchored-tools.mjs')),
      contractAnchor: await lib.sha256File(join(contractAnchorSource, 'contract-anchor.mjs')),
    },
    samples: [],
    failures: [],
    censoredSamples: [],
  }
  await writeJson(join(runDir, 'manifest.json'), manifest)
  const scores = []
  const evaluations = []
  const runtime = await buildRuntime({ port, runDir })
  try {
    for (const [index, condition] of selectedConditions.entries()) {
      process.stdout.write(`[start] ${condition.id} ${route.provider}/${route.model} ${route.reasoningEffort}\n`)
      const workspace = await prepareHandoff(condition, control, runtimeRoot)
      const record = {
        id: condition.id,
        suite: 'modeltest-project2-v4.1b',
        condition: condition.id,
        repeat: 1,
        platform: 'windows-native',
        prompt,
        sessionId: null,
        sentAt: null,
        eventFile: `conditions/${condition.id}/events.jsonl`,
        workspace,
      }
      try {
        const result = await runSession({ rpc: runtime.rpc, history: runtime.history, condition, cwd: workspace, prompt, runId })
        record.sessionId = result.sessionId
        record.sentAt = result.sentAt
        record.budgetStop = result.budgetStop
        record.terminalReason = result.events.findLast(event => event.type === 'turn/end')?.data?.reason ?? null
        record.completed = record.terminalReason?.kind === 'completed'
        await lib.writeEvents(join(runDir, record.eventFile), result.events)
        const assistantMessages = result.events.filter(event => event.type === 'assistant/message')
        if (assistantMessages.length === 0) {
          const failure = record.terminalReason?.error
          manifest.samples.push(record)
          manifest.failures.push({
            id: condition.id,
            at: new Date().toISOString(),
            stage: 'model-request',
            error: failure === undefined
              ? 'turn ended before the first assistant/message'
              : `${failure.code ?? 'MODEL_ERROR'}: ${failure.message ?? JSON.stringify(failure)}`,
          })
          await writeJson(join(runDir, 'manifest.json'), manifest)
          process.stdout.write(`[blocked] ${condition.id} ${manifest.failures.at(-1).error}\n`)
          break
        }
        const score = lib.scoreTrajectory(record, result.events)
        score.tools = toolSummary(result.events)
        score.cache = cacheSummary(score.usage)
        score.budgetStop = result.budgetStop
        score.completed = record.completed
        score.schemaHashes = [...new Set(score.firstThree.map(message => message.toolSchemaSha256))]
        const headers = result.events.filter(event => event.type === 'request/header')
        score.allRequestToolSchemaHashes = [...new Set(headers.map(event => lib.sha256(lib.canonicalJson(event.data?.header?.tools ?? []))))]
        score.allRequestSystemHashes = [...new Set(headers.map(event => lib.sha256(String(event.data?.header?.system ?? ''))))]
        score.maxTokensSeen = [...new Set(headers.map(event => event.data?.header?.config?.maxTokens ?? null))]
        score.reasoningEffortSeen = [...new Set(headers.map(event => event.data?.header?.config?.reasoningEffort ?? null))]
        scores.push(score)
        await writeJson(join(runDir, 'scores.json'), scores)
        const evaluated = skipEvaluator
          ? {
              id: condition.id,
              evaluatorSkipped: true,
              censored: true,
              ability: null,
              ship: null,
              releaseClass: null,
              blockers: [],
            }
          : await evaluate({
              condition,
              control,
              candidateProject: join(workspace, 'project2_task'),
              runDir,
              score,
              index,
            })
        evaluations.push(evaluated)
        manifest.samples.push(record)
        if (!record.completed) {
          manifest.censoredSamples.push({ id: condition.id, terminalReason: record.terminalReason })
        }
        await writeJson(join(runDir, 'evaluations.json'), evaluations)
        await writeJson(join(runDir, 'manifest.json'), manifest)
        if (skipEvaluator) {
          process.stdout.write(`[probe] ${condition.id} evaluator skipped after ${score.requestCount} requests\n`)
        } else {
          process.stdout.write(`[done] ${condition.id} Ability=${evaluated.ability} Ship=${evaluated.ship} Release=${evaluated.releaseClass}\n`)
        }
        if (record.terminalReason?.error?.code === 'QUOTA') break
      } catch (error) {
        manifest.failures.push({ id: condition.id, at: new Date().toISOString(), error: String(error?.message ?? error) })
        await writeJson(join(runDir, 'manifest.json'), manifest)
        throw error
      }
    }
  } finally {
    await runtime.close()
  }

  const summary = {
    runId,
    route,
    endpoint: manifest.endpoint,
    modeltestCommit,
    qualityComparable: scores.length === selectedConditions.length && scores.every(score => score.completed === true),
    rows: selectedConditions.map(condition => {
      const score = scores.find(row => row.condition === condition.id)
      const evaluation = evaluations.find(row => row.id === condition.id)
      return {
        condition: condition.id,
        completed: score?.completed ?? false,
        scoreStatus: score?.completed ? 'complete' : 'censored',
        ability: evaluation?.ability ?? null,
        ship: evaluation?.ship ?? null,
        releaseClass: evaluation?.releaseClass ?? null,
        blockers: evaluation?.blockers ?? [],
        requests: score?.requestCount ?? null,
        toolCalls: score?.tools?.total ?? null,
        reasoningTokens: score?.usage?.reasoningTokens ?? null,
        outputTokens: score?.usage?.outputTokens ?? null,
        inputTokens: score?.cache?.totalInputTokens ?? null,
        cacheHitRate: score?.cache?.hitRate ?? null,
        estimatedCostUsd: score?.cost?.estimated ?? null,
        firstSystemChars: score?.firstSystemChars ?? null,
        firstToolNames: score?.firstToolNames ?? [],
        firstReasoningChars: score?.firstReasoningChars ?? null,
        firstToolCalls: score?.firstToolCallCount ?? null,
        firstBreadth: score?.firstBreadth ?? null,
        schemaStates: score?.allRequestToolSchemaHashes?.length ?? null,
        maxTokensSeen: score?.maxTokensSeen ?? [],
        budgetStop: score?.budgetStop ?? null,
      }
    }),
  }
  await writeJson(join(runDir, 'summary.json'), summary)
  await lib.scanTreeForSecrets(runDir)
  await writeFile(join(here, 'latest-run.txt'), `${relative(here, runDir).replaceAll('\\', '/')}\n`, 'utf8')
  await cp(join(runDir, 'summary.json'), join(here, 'latest-summary.json'), { force: true })
  process.stdout.write(`[complete] ${runDir}\n`)
}

async function replay(runDir) {
  const resolved = resolve(runDir)
  const manifest = await readJson(join(resolved, 'manifest.json'))
  process.env.DSH_EVAL_PLATFORM = manifest.platform
  const lib = await import('../dsv4-anchored-official/lib.mjs')
  const oldScores = await readJson(join(resolved, 'scores.json'))
  const nextScores = []
  for (const sample of manifest.samples) {
    const events = await lib.readEvents(join(resolved, sample.eventFile))
    const score = lib.scoreTrajectory(sample, events)
    if (Object.hasOwn(sample, 'completed')) score.completed = sample.completed
    score.tools = toolSummary(events)
    score.cache = cacheSummary(score.usage)
    score.budgetStop = sample.budgetStop ?? null
    score.schemaHashes = [...new Set(score.firstThree.map(message => message.toolSchemaSha256))]
    const headers = events.filter(event => event.type === 'request/header')
    score.allRequestToolSchemaHashes = [...new Set(headers.map(event => lib.sha256(lib.canonicalJson(event.data?.header?.tools ?? []))))]
    score.allRequestSystemHashes = [...new Set(headers.map(event => lib.sha256(String(event.data?.header?.system ?? ''))))]
    score.maxTokensSeen = [...new Set(headers.map(event => event.data?.header?.config?.maxTokens ?? null))]
    score.reasoningEffortSeen = [...new Set(headers.map(event => event.data?.header?.config?.reasoningEffort ?? null))]
    nextScores.push(score)
  }
  const previous = lib.canonicalJson(oldScores, 2)
  const next = lib.canonicalJson(nextScores, 2)
  if (previous !== next) throw new Error(`replay mismatch: ${lib.sha256(previous)} != ${lib.sha256(next)}`)
  process.stdout.write(`[replay] byte-identical scores ${lib.sha256(next)}\n`)
}

async function execChecked(file, args, options = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const result = await promisify(execFile)(file, args, {
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

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

if (mode === 'live') {
  await live()
} else if (mode === 'replay') {
  const runDir = process.argv[3]
  if (!runDir) throw new Error('usage: runner.mjs replay RUN_DIR')
  await replay(runDir)
} else {
  throw new Error('usage: runner.mjs live [--condition router-standard|progressive-guarded|pro-anchored-96|pro-contract-anchor] | replay RUN_DIR')
}
