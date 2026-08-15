#!/usr/bin/env node
import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

import {
  BASE_URL,
  DOCKER_CONTAINER,
  HERE,
  MODELTEST,
  PLATFORM,
  PRESET_ROOT,
  PYTHON,
  SOURCE_ROOT,
  agentPath,
  canonicalJson,
  commandText,
  estimateCost,
  execChecked,
  extractCandidatePrompt,
  history,
  manifestSafeName,
  pathExists,
  readEvents,
  readJson,
  rpc,
  scanTreeForSecrets,
  scoreTrajectory,
  sha256,
  sha256File,
  sumUsage,
  treeHash,
  writeEvents,
  writeJson,
  writeTextSecure,
  runSession,
} from './lib.mjs'
import {
  MINIMAL_SYSTEM,
  OFFICIAL_BASE_URL,
  PRESET_IDS,
  PRICING,
  PROJECT_SESSION_PREFIX,
  ROUTE,
  matrixFor,
  shellTool,
} from './constants.mjs'
import { reportMarkdown } from './report.mjs'

const argv = process.argv.slice(2)
const mode = argv[0] ?? 'live'
const matrix = matrixFor(PLATFORM)
const hostManagedCredential = process.env.DSH_EVAL_HOST_MANAGED_CREDENTIAL === '1'

function option(name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function platformSlug(platform) {
  return platform === 'windows-native' ? 'win' : 'linux'
}

async function gitText(cwd, args) {
  const result = await execChecked('git', ['-c', `safe.directory=${cwd}`, ...args], { cwd, allowFailure: true })
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function preflightLive() {
  if (!process.env.DEEPSEEK_API_KEY && !hostManagedCredential) {
    throw new Error('MISSING_CREDENTIAL: set a rotated DEEPSEEK_API_KEY in the runner, or set DSH_EVAL_HOST_MANAGED_CREDENTIAL=1 when the selected DSH Host already owns the configured credential')
  }
  if (process.env.DEEPSEEK_BASE_URL && process.env.DEEPSEEK_BASE_URL.replace(/\/$/, '') !== OFFICIAL_BASE_URL) {
    throw new Error(`BASE_URL_MISMATCH: DEEPSEEK_BASE_URL must be ${OFFICIAL_BASE_URL}`)
  }
  if (!(await pathExists(MODELTEST))) throw new Error(`frozen Project2 checkout missing: ${MODELTEST}`)
  for (const preset of Object.values(PRESET_IDS)) {
    if (!(await pathExists(join(PRESET_ROOT, preset, 'agent.cordis.yml')))) {
      throw new Error(`preset missing: ${preset}; run node prepare-presets.mjs before starting the DSH Host`)
    }
  }
  const response = await fetch(BASE_URL).catch(error => {
    throw new Error(`DSH_HOST_UNREACHABLE: ${BASE_URL}: ${error.message}`)
  })
  if (!response.ok) throw new Error(`DSH_HOST_UNHEALTHY: ${BASE_URL} returned HTTP ${response.status}`)
}

async function resultDirectories() {
  const root = join(MODELTEST, 'evaluator', 'results')
  if (!(await pathExists(root))) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

async function baseManifest(runId, suites) {
  const dshStatus = await gitText(SOURCE_ROOT, ['status', '--porcelain=v1'])
  const projectStatus = await gitText(MODELTEST, ['status', '--porcelain=v1'])
  const generated = await readJson(join(HERE, 'generated-presets.json'))
  const presetHashes = {}
  for (const [condition, preset] of Object.entries(PRESET_IDS)) {
    presetHashes[condition] = await treeHash(join(PRESET_ROOT, preset))
  }
  const versions = PLATFORM === 'linux-docker'
    ? {
        node: await commandText('docker', ['exec', DOCKER_CONTAINER, 'node', '--version'], MODELTEST),
        pnpm: await commandText('docker', ['exec', DOCKER_CONTAINER, 'pnpm', '--version'], MODELTEST),
        python: await commandText('docker', ['exec', DOCKER_CONTAINER, 'python', '--version'], MODELTEST),
      }
    : {
        node: process.version,
        pnpm: await commandText('pnpm', ['--version'], SOURCE_ROOT),
        python: await commandText(PYTHON, ['--version'], HERE),
      }
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    platform: PLATFORM,
    suites,
    hostBaseUrl: BASE_URL,
    officialBaseUrl: OFFICIAL_BASE_URL,
    route: ROUTE,
    pricing: PRICING,
    dsh: {
      sourceRoot: SOURCE_ROOT,
      commit: await gitText(SOURCE_ROOT, ['rev-parse', 'HEAD']),
      dirty: Boolean(dshStatus),
      statusSha256: sha256(dshStatus),
    },
    versions,
    hashes: {
      minimalSystem: sha256(MINIMAL_SYSTEM),
      matrix: sha256(canonicalJson(matrix)),
      constants: await sha256File(join(HERE, 'constants.mjs')),
      reportCode: await sha256File(join(HERE, 'report.mjs')),
      runnerCode: await sha256File(new URL(import.meta.url)),
      standardSource: generated.standardSha256,
      presets: presetHashes,
    },
    project2: {
      repository: 'https://github.com/xiaobright/modeltest',
      root: MODELTEST,
      commit: await gitText(MODELTEST, ['rev-parse', 'HEAD']),
      dirty: Boolean(projectStatus),
      statusSha256: sha256(projectStatus),
      candidatePromptSha256: await sha256File(join(MODELTEST, 'CANDIDATE_PROMPT.md')),
      evaluatorSha256: await treeHash(join(MODELTEST, 'evaluator', 'scoring')),
    },
    credential: hostManagedCredential
      ? {
          source: 'configured DSH Host',
          variable: null,
          runnerPresent: Boolean(process.env.DEEPSEEK_API_KEY),
          hostManaged: true,
          valueInspected: false,
          persistedInRunArtifacts: false,
        }
      : {
          source: 'process environment',
          variable: 'DEEPSEEK_API_KEY',
          runnerPresent: true,
          hostManaged: false,
          valueInspected: false,
          persistedInRunArtifacts: false,
        },
    samples: [],
    failedAttempts: [],
    approvalDecisions: [],
  }
}

async function saveState(runDir, manifest, scores, projectResults, verification = undefined) {
  await writeJson(join(runDir, 'manifest.json'), manifest)
  await writeJson(join(runDir, 'scores.json'), scores)
  await writeJson(join(runDir, 'project2-results.json'), projectResults)
  for (const score of scores) {
    await writeJson(join(runDir, 'trajectories', `${score.id}.json`), {
      id: score.id,
      prompt: score.prompt,
      promptSha256: score.promptSha256,
      firstHeaderSha256: score.firstHeaderSha256,
      firstSystemSha256: score.firstSystemSha256,
      firstToolSchemaSha256: score.firstToolSchemaSha256,
      firstThree: score.firstThree,
    })
  }
  await writeTextSecure(join(runDir, 'report.md'), reportMarkdown({ manifest, scores, projectResults, verification }))
}

async function prepareHandoff(sample, runDir, attempt) {
  const attemptName = `${sample.id}-attempt-${attempt}`
  const workspaceRoot = PLATFORM === 'windows-native'
    ? resolve(process.env.DSH_EVAL_WORK_ROOT
      ?? join(HERE, '..', '..', '..', '.project2-handoffs', 'dsv4-official', basename(runDir)))
    : join(runDir, 'workspaces')
  const output = join(workspaceRoot, attemptName, 'workspace')
  await mkdir(join(workspaceRoot, attemptName), { recursive: true })
  if (PLATFORM === 'linux-docker') {
    await execChecked('docker', [
      'exec', DOCKER_CONTAINER, 'python', agentPath(join(MODELTEST, 'evaluator', 'make_broken_project.py')),
    ], { cwd: MODELTEST })
    await execChecked('docker', [
      'exec', DOCKER_CONTAINER, 'python', agentPath(join(MODELTEST, 'evaluator', 'prepare_candidate_handoff.py')),
      '--source', agentPath(join(MODELTEST, 'workspace')),
      '--output', agentPath(output),
    ], { cwd: MODELTEST })
  } else {
    await execChecked(PYTHON, [join(MODELTEST, 'evaluator', 'make_broken_project.py')], { cwd: MODELTEST })
    const gitignore = join(MODELTEST, 'workspace', 'project2_task', '.gitignore')
    const gitignoreText = await readFile(gitignore, 'utf8')
    if (gitignoreText.includes('\r\n')) await writeTextSecure(gitignore, gitignoreText.replaceAll('\r\n', '\n'))
    await execChecked(PYTHON, [
      join(MODELTEST, 'evaluator', 'prepare_candidate_handoff.py'),
      '--source', join(MODELTEST, 'workspace'),
      '--output', output,
    ], { cwd: MODELTEST })
  }
  return { output, handoffSha256: await treeHash(output), attemptName }
}

function sessionIdFor(runId, sample, attempt) {
  const prefix = sample.suite === 'probe' ? 'probe-dsv4-official-' : PROJECT_SESSION_PREFIX
  return `${prefix}${platformSlug(PLATFORM)}-${runId}-${sample.id}-a${attempt}`
}

class ApprovalDriver {
  constructor(runDir, manifest) {
    this.runDir = runDir
    this.manifest = manifest
    this.socket = undefined
  }

  async start() {
    const url = new URL('/api/events.mux', BASE_URL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    await new Promise((resolveReady, rejectReady) => {
      socket.addEventListener('open', resolveReady, { once: true })
      socket.addEventListener('error', () => rejectReady(new Error(`approval websocket failed: ${url}`)), { once: true })
    })
    socket.addEventListener('message', event => void this.handle(event))
  }

  async handle(event) {
    try {
      if (typeof event.data !== 'string') return
      const envelope = JSON.parse(event.data)
      const request = envelope?.payload
      if (envelope?.type !== 'server-request' || request?.type !== 'approval/requested') return
      if (!String(request.sessionId).startsWith(PROJECT_SESSION_PREFIX)) return
      const allowedTool = String(request.toolName) === shellTool(PLATFORM)
      const allowedReason = /escalate sandbox to (?:workspace-write|danger-full-access)/i.test(String(request.reason ?? ''))
      const outcome = allowedTool && allowedReason ? 'allowed-once' : 'rejected'
      const response = await fetch(new URL('/api/respond', BASE_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { sessionId: request.sessionId, approvalId: request.approvalId, outcome } },
        }),
      })
      this.manifest.approvalDecisions.push({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        toolName: request.toolName,
        reason: request.reason,
        outcome,
        responseStatus: response.status,
      })
      await writeJson(join(this.runDir, 'approval-decisions.json'), this.manifest.approvalDecisions)
    } catch (error) {
      this.manifest.approvalDecisions.push({ error: String(error?.message ?? error) })
    }
  }

  close() {
    this.socket?.close(1000, 'experiment complete')
  }
}

function officialProjection(summary, scoreDraft, blockers, resultDir) {
  return {
    officialScore: scoreDraft?.ability_draft ?? summary?.ability_draft ?? null,
    shipDraft: scoreDraft?.ship_draft ?? summary?.ship_draft ?? null,
    releaseClassHint: scoreDraft?.release_class_hint ?? summary?.release_class_hint ?? null,
    f9Mode: scoreDraft?.f9_mode ?? summary?.f9_mode ?? null,
    f11Status: scoreDraft?.f11_status ?? summary?.f11_status ?? null,
    blockers: blockers?.final ?? summary?.blockers ?? [],
    behaviorBlockers: blockers?.behavior_blockers ?? summary?.behavior_blockers ?? [],
    semanticOnlyCodes: blockers?.semantic_only_codes ?? summary?.semantic_only_codes ?? [],
    familyDraft: scoreDraft?.family_draft ?? summary?.family_draft ?? {},
    dimensions: summary?.dimensions ?? {},
    steps: summary?.steps ?? {},
    resultDir,
  }
}

async function evaluateProject(sample, candidateProject, runDir, score) {
  const before = new Set(await resultDirectories())
  const metaExtra = join(runDir, 'project2', sample.id, 'meta-extra.json')
  await writeJson(metaExtra, {
    condition: sample.condition,
    provider_requests: score.requestCount,
    token_usage: score.usage,
    estimated_cost_usd: score.cost.estimated,
    first_system_sha256: score.firstSystemSha256,
    first_tool_schema_sha256: score.firstToolSchemaSha256,
    promotion: score.promotion,
  })
  const evaluator = PLATFORM === 'linux-docker'
    ? agentPath(join(MODELTEST, 'evaluator', 'run_full_eval.py'))
    : join(MODELTEST, 'evaluator', 'run_full_eval.py')
  const project = PLATFORM === 'linux-docker' ? agentPath(candidateProject) : candidateProject
  const meta = PLATFORM === 'linux-docker' ? agentPath(metaExtra) : metaExtra
  const evalArgs = [
    evaluator,
    project,
    '--model', ROUTE.model,
    '--channel', ROUTE.provider,
    '--harness', `dsh-${sample.condition}`,
    '--require-meta',
    '--include-espidf-build',
    '--run-group-id', `dsv4-official-${platformSlug(PLATFORM)}-${sample.condition}-max`,
    '--run-index', '1',
    '--thinking-level', ROUTE.reasoningEffort,
    '--provider', ROUTE.provider,
    '--endpoint-product', 'deepseek-api',
    '--meta-extra', meta,
  ]
  const evaluated = PLATFORM === 'linux-docker'
    ? await execChecked('docker', ['exec', DOCKER_CONTAINER, 'python', ...evalArgs], { cwd: MODELTEST, allowFailure: true })
    : await execChecked(PYTHON, evalArgs, { cwd: MODELTEST, allowFailure: true })
  await writeTextSecure(join(runDir, 'project2', sample.id, 'evaluator.stdout.log'), evaluated.stdout)
  await writeTextSecure(join(runDir, 'project2', sample.id, 'evaluator.stderr.log'), evaluated.stderr)
  const created = (await resultDirectories()).filter(name => !before.has(name))
  if (created.length !== 1) throw new Error(`${sample.id}: expected one evaluator result directory, got ${created.join(', ')}`)
  const source = join(MODELTEST, 'evaluator', 'results', created[0])
  const target = join(runDir, 'project2', sample.id, 'official')
  await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  const summary = await readJson(join(target, 'summary.json'))
  const scoreDraft = await readJson(join(target, 'score_draft.json')).catch(() => ({}))
  const blockers = await readJson(join(target, 'blockers.json')).catch(() => ({}))
  const dimensions = await readJson(join(target, 'dimensions.json')).catch(() => ({}))
  return {
    id: sample.id,
    condition: sample.condition,
    repeat: sample.repeat,
    platform: PLATFORM,
    evaluatorExitCode: evaluated.code,
    ...officialProjection(summary, scoreDraft, blockers, relative(runDir, target).replaceAll('\\', '/')),
    dimensions,
    providerRequests: score.requestCount,
    tokenUsage: score.usage,
    estimatedCostUsd: score.cost.estimated,
    durationSec: summary?.duration_sec ?? null,
    outsideBootstrapToolsUsed: score.promotion.outsideBootstrapToolsUsed,
  }
}

async function hydrateProjectResults(runDir, projectResults) {
  const hydrated = []
  for (const result of projectResults) {
    const root = join(runDir, result.resultDir)
    const summary = await readJson(join(root, 'summary.json')).catch(() => ({}))
    const scoreDraft = await readJson(join(root, 'score_draft.json')).catch(() => ({}))
    const blockers = await readJson(join(root, 'blockers.json')).catch(() => ({}))
    const dimensions = await readJson(join(root, 'dimensions.json')).catch(() => ({}))
    hydrated.push({
      ...result,
      ...officialProjection(summary, scoreDraft, blockers, result.resultDir),
      dimensions,
    })
  }
  return hydrated
}

async function runMatrix(runDir, manifest, scores, projectResults, suites) {
  const candidateMarkdown = await readFile(join(MODELTEST, 'CANDIDATE_PROMPT.md'), 'utf8')
  const prompt = extractCandidatePrompt(candidateMarkdown)
  const approvalDriver = new ApprovalDriver(runDir, manifest)
  await approvalDriver.start()
  try {
    for (const sample of matrix.filter(entry => suites.includes(entry.suite))) {
      if (manifest.samples.some(existing => existing.id === sample.id)) continue
      const attempt = manifest.failedAttempts.filter(entry => entry.id === sample.id).length + 1
      const prepared = await prepareHandoff(sample, runDir, attempt)
      const existingHandoffHashes = manifest.samples.map(entry => entry.handoffSha256).filter(Boolean)
      if (existingHandoffHashes.length > 0 && existingHandoffHashes[0] !== prepared.handoffSha256) {
        throw new Error(`${sample.id}: frozen handoff hash drifted from ${existingHandoffHashes[0]} to ${prepared.handoffSha256}`)
      }
      const sessionId = sessionIdFor(manifest.runId, sample, attempt)
      const eventFile = `events/${sample.id}-attempt-${attempt}.jsonl`
      const record = {
        ...sample,
        platform: PLATFORM,
        sessionId,
        prompt,
        sentAt: null,
        eventFile,
        workspace: relative(runDir, prepared.output).replaceAll('\\', '/'),
        handoffSha256: prepared.handoffSha256,
      }
      console.log(`[${sample.suite}] ${sample.condition} -> ${sessionId}`)
      let result
      try {
        result = await runSession({
          sessionId,
          title: `DSV4 official ${PLATFORM} ${sample.suite} ${sample.condition}`,
          cwd: agentPath(prepared.output),
          preset: sample.preset,
          prompt,
          timeoutMs: sample.suite === 'probe' ? 600_000 : 3_600_000,
        })
        record.sentAt = result.sentAt
        await writeEvents(join(runDir, eventFile), result.events)
        const terminalError = result.events.find(event => event.type === 'turn/end' && event.data?.reason?.kind === 'error')?.data?.reason
        if (terminalError) throw new Error(`provider turn ended with ${terminalError?.error?.code ?? 'error'}`)
        const score = scoreTrajectory(record, result.events)
        if (sample.suite === 'project2') {
          const project = await evaluateProject(sample, join(prepared.output, 'project2_task'), runDir, score)
          projectResults.push(project)
        }
        manifest.samples.push(record)
        scores.push(score)
        await saveState(runDir, manifest, scores, projectResults)
      } catch (error) {
        const observed = result?.events ?? await history(sessionId).catch(() => [])
        if (observed.length > 0) await writeEvents(join(runDir, eventFile), observed)
        manifest.failedAttempts.push({
          id: sample.id,
          condition: sample.condition,
          suite: sample.suite,
          attempt,
          sessionId,
          eventFile,
          handoffSha256: prepared.handoffSha256,
          failedAt: new Date().toISOString(),
          error: String(error?.message ?? error),
        })
        await saveState(runDir, manifest, scores, projectResults)
        throw error
      }
    }
  } finally {
    approvalDriver.close()
  }
}

async function live(suites) {
  await preflightLive()
  const runId = `run-${platformSlug(PLATFORM)}-${stamp()}`
  const runDir = join(HERE, 'runs', runId)
  await mkdir(runDir, { recursive: true })
  const manifest = await baseManifest(runId, suites)
  const scores = []
  const projectResults = []
  await saveState(runDir, manifest, scores, projectResults)
  await runMatrix(runDir, manifest, scores, projectResults, suites)
  manifest.secretScan = await scanTreeForSecrets(runDir)
  await saveState(runDir, manifest, scores, projectResults)
  console.log(`[done] ${runDir}`)
}

async function resume(runDir) {
  await preflightLive()
  const manifest = await readJson(join(runDir, 'manifest.json'))
  if (manifest.platform !== PLATFORM) throw new Error(`platform mismatch: run=${manifest.platform}, process=${PLATFORM}`)
  const scores = await readJson(join(runDir, 'scores.json'))
  const projectResults = await hydrateProjectResults(
    runDir,
    await readJson(join(runDir, 'project2-results.json')).catch(() => []),
  )
  await runMatrix(runDir, manifest, scores, projectResults, manifest.suites)
  manifest.secretScan = await scanTreeForSecrets(runDir)
  await saveState(runDir, manifest, scores, projectResults)
  console.log(`[resumed] ${runDir}`)
}

async function replay(runDir) {
  const manifest = await readJson(join(runDir, 'manifest.json'))
  const scores = []
  for (const sample of manifest.samples) {
    scores.push(scoreTrajectory(sample, await readEvents(join(runDir, sample.eventFile))))
  }
  const previous = await readFile(join(runDir, 'scores.json'), 'utf8')
  const next = canonicalJson(scores, 2)
  if (previous !== next) {
    throw new Error(`REPLAY_MISMATCH: previous=${sha256(previous)} replay=${sha256(next)}`)
  }
  const projectResults = await hydrateProjectResults(
    runDir,
    await readJson(join(runDir, 'project2-results.json')).catch(() => []),
  )
  await saveState(runDir, manifest, scores, projectResults)
  const replayRecord = {
    replayedAt: new Date().toISOString(),
    modelRequests: 0,
    scoresByteIdentical: true,
    scoresSha256: sha256(next),
  }
  await writeJson(join(runDir, 'replay.json'), replayRecord)
  console.log(`[replay] scores.json byte-identical: ${replayRecord.scoresSha256}`)
}

if (mode === 'live') {
  await live(['probe', 'project2'])
} else if (mode === 'probe-live') {
  await live(['probe'])
} else if (mode === 'project2-live') {
  await live(['project2'])
} else if (mode === 'resume') {
  const target = option('--run')
  if (!target) throw new Error('usage: reproduce.mjs resume --run <run-directory>')
  await resume(resolve(target))
} else if (mode === 'replay') {
  const target = option('--run')
  if (!target) throw new Error('usage: reproduce.mjs replay --run <run-directory>')
  await replay(resolve(target))
} else {
  throw new Error('usage: reproduce.mjs live|probe-live|project2-live|resume|replay [--run DIR]')
}
