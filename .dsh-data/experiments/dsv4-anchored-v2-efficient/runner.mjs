#!/usr/bin/env node
import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BASE_URL,
  MODELTEST,
  PLATFORM,
  PRESET_ROOT,
  PYTHON,
  SOURCE_ROOT,
  agentPath,
  canonicalJson,
  estimateCost,
  execChecked,
  extractCandidatePrompt,
  history,
  messageContent,
  pathExists,
  readEvents,
  readJson,
  rpc,
  scanTreeForSecrets,
  scoreTrajectory,
  sha256,
  sha256File,
  treeHash,
  writeEvents,
  writeJson,
  writeTextSecure,
  runSession,
} from '../dsv4-anchored-official/lib.mjs'
import { OFFICIAL_BASE_URL, PRICING } from '../dsv4-anchored-official/constants.mjs'
import {
  COMPACT_CONTRACT,
  CAPABILITY_NOTE,
  CORE_TOOLS,
  MINIMAL_PERSONA,
  MICRO_SESSION_PREFIX,
  NOTED_READ_MICRO_SESSION_PREFIX,
  PREFETCH_MICRO_SESSION_PREFIX,
  READ_MICRO_SESSION_PREFIX,
  PRESETS,
  PROJECT_SESSION_PREFIX,
  PROBE_SESSION_PREFIX,
  ROUTE,
  nativeShell,
} from './constants.mjs'
import { qualifiedCall, successfulResult } from './plugins/v2-policy.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const mode = argv[0] ?? 'probe-live'

function option(name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function platformSlug() {
  return PLATFORM === 'windows-native' ? 'win' : 'linux'
}

function callArguments(event) {
  const value = event?.data?.arguments
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) } catch { return { raw: value } }
}

function resultBlock(event) {
  return event?.data?.message?.content?.find?.(block => block?.type === 'tool-result')
}

function scoreV2(sample, events) {
  const base = scoreTrajectory(sample, events)
  const calls = new Map()
  let evidenceResult
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data?.callId, event)
    if (evidenceResult || event.type !== 'tool/result' || !successfulResult(event)) continue
    const call = calls.get(resultBlock(event)?.toolCallId ?? event.data?.callId)
    if (qualifiedCall(call)) evidenceResult = event
  }
  const headers = events.filter(event => event.type === 'request/header')
  const coreCount = CORE_TOOLS.length + 1
  const promotionHeader = evidenceResult === undefined ? undefined : headers.find(event =>
    event.seq > evidenceResult.seq && (event.data?.header?.tools?.length ?? 0) === coreCount)
  const allToolCalls = events.filter(event => event.type === 'tool/call')
  const allowed = new Set([...CORE_TOOLS, nativeShell(PLATFORM)])
  const prohibitedTools = [...new Set(allToolCalls.map(event => event.data?.name).filter(name => !allowed.has(name)))]
  const denialTexts = events.filter(event => event.type === 'tool/result')
    .map(event => canonicalJson(resultBlock(event)?.content ?? ''))
    .filter(text => /V[2346]_(?:BOOTSTRAP|FIRST_RESPONSE|INVENTORY|NO_PROGRESS)/.test(text))
  return {
    ...base,
    v2: {
      qualifiedEvidenceResultSeq: evidenceResult?.seq ?? null,
      corePromotionHeaderSeq: promotionHeader?.seq ?? null,
      promotedAfterQualifiedResult: evidenceResult !== undefined && promotionHeader !== undefined,
      promotedToolCount: promotionHeader?.data?.header?.tools?.length ?? null,
      promotedToolNames: promotionHeader?.data?.header?.tools?.map(tool => tool.name) ?? [],
      prohibitedTools,
      guardDenialCount: denialTexts.length,
      guardDenials: denialTexts,
    },
  }
}

async function preflight() {
  if (!process.env.DEEPSEEK_API_KEY && process.env.DSH_EVAL_HOST_MANAGED_CREDENTIAL !== '1') {
    throw new Error('MISSING_CREDENTIAL: use a configured DSH Host or provide DEEPSEEK_API_KEY by process environment')
  }
  if (!(await pathExists(MODELTEST))) throw new Error(`missing frozen Project2: ${MODELTEST}`)
  for (const preset of Object.values(PRESETS)) {
    if (!(await pathExists(join(PRESET_ROOT, preset, 'agent.cordis.yml')))) throw new Error(`missing preset: ${preset}`)
  }
  const response = await fetch(BASE_URL)
  if (!response.ok) throw new Error(`DSH Host returned ${response.status}: ${BASE_URL}`)
}

async function gitText(cwd, args) {
  const result = await execChecked('git', ['-c', `safe.directory=${cwd}`, ...args], { cwd, allowFailure: true })
  return result.code === 0 ? result.stdout.trim() : `unavailable:${result.code}`
}

async function baseManifest(runId, suite, baselineRun) {
  return {
    schemaVersion: 2,
    experiment: 'dsv4-anchored-v2-efficient',
    generatedAt: new Date().toISOString(),
    runId,
    platform: PLATFORM,
    suite,
    hostBaseUrl: BASE_URL,
    officialBaseUrl: OFFICIAL_BASE_URL,
    route: ROUTE,
    pricing: PRICING,
    baselineRun: baselineRun ? resolve(baselineRun) : null,
    credential: {
      source: process.env.DSH_EVAL_HOST_MANAGED_CREDENTIAL === '1' ? 'configured DSH Host' : 'process environment',
      valueInspected: false,
      persistedInRunArtifacts: false,
    },
    dsh: { sourceRoot: SOURCE_ROOT, commit: await gitText(SOURCE_ROOT, ['rev-parse', 'HEAD']) },
    project2: {
      root: MODELTEST,
      commit: await gitText(MODELTEST, ['rev-parse', 'HEAD']),
      candidatePromptSha256: await sha256File(join(MODELTEST, 'CANDIDATE_PROMPT.md')),
    },
    hashes: {
      compactContract: sha256(COMPACT_CONTRACT),
      capabilityNote: sha256(CAPABILITY_NOTE),
      minimalPersona: sha256(MINIMAL_PERSONA),
      runner: await sha256File(new URL(import.meta.url)),
      policy: await sha256File(join(here, 'plugins', 'v2-policy.mjs')),
      v3Policy: await sha256File(join(here, 'plugins', 'v3-policy.mjs')),
      v4Policy: await sha256File(join(here, 'plugins', 'v4-policy.mjs')),
      v6Policy: await sha256File(join(here, 'plugins', 'v6-prefetch-policy.mjs')),
      generatedPresets: await sha256File(join(here, 'generated-presets.json')),
    },
    samples: [],
    failures: [],
  }
}

async function save(runDir, manifest, scores, projectResults, selection = undefined) {
  await writeJson(join(runDir, 'manifest.json'), manifest)
  await writeJson(join(runDir, 'scores.json'), scores)
  await writeJson(join(runDir, 'project2-results.json'), projectResults)
  if (selection) await writeJson(join(runDir, 'selection.json'), selection)
  await writeTextSecure(join(runDir, 'report.md'), await reportText(manifest, scores, projectResults, selection))
}

async function prepareHandoff(sample, runDir) {
  const attemptName = `${sample.id}-attempt-1`
  const workspaceRoot = PLATFORM === 'windows-native'
    ? resolve(join(here, '..', '..', '..', '.project2-handoffs', 'dsv4-v2', basename(runDir)))
    : join(runDir, 'workspaces')
  const output = join(workspaceRoot, attemptName, 'workspace')
  await mkdir(join(workspaceRoot, attemptName), { recursive: true })
  if (PLATFORM === 'linux-docker') {
    throw new Error('efficient runner Linux handoff is not enabled in this token-saving Windows selection pass')
  }
  await execChecked(PYTHON, [join(MODELTEST, 'evaluator', 'make_broken_project.py')], { cwd: MODELTEST })
  const gitignore = join(MODELTEST, 'workspace', 'project2_task', '.gitignore')
  const text = await readFile(gitignore, 'utf8')
  if (text.includes('\r\n')) await writeTextSecure(gitignore, text.replaceAll('\r\n', '\n'))
  await execChecked(PYTHON, [
    join(MODELTEST, 'evaluator', 'prepare_candidate_handoff.py'),
    '--source', join(MODELTEST, 'workspace'),
    '--output', output,
  ], { cwd: MODELTEST })
  return { output, handoffSha256: await treeHash(output), attemptName }
}

class ApprovalDriver {
  constructor(manifest) { this.manifest = manifest }
  async start() {
    const url = new URL('/api/events.mux', BASE_URL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
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
      if (!String(request.sessionId).startsWith(PROJECT_SESSION_PREFIX)) return
      const allowed = request.toolName === nativeShell(PLATFORM)
        && /escalate sandbox to (?:workspace-write|danger-full-access)/i.test(String(request.reason ?? ''))
      await fetch(new URL('/api/respond', BASE_URL), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId: envelope.rpcId, result: { ok: true, value: { sessionId: request.sessionId, approvalId: request.approvalId, outcome: allowed ? 'allowed-once' : 'rejected' } } }),
      })
    } catch (error) {
      this.manifest.failures.push({ approvalError: String(error?.message ?? error) })
    }
  }
  close() { this.socket?.close(1000, 'complete') }
}

async function resultDirectories() {
  const root = join(MODELTEST, 'evaluator', 'results')
  if (!(await pathExists(root))) return []
  return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

async function evaluateProject(sample, candidateProject, runDir, score) {
  const before = new Set(await resultDirectories())
  const metaExtra = join(runDir, 'project2', sample.id, 'meta-extra.json')
  await writeJson(metaExtra, {
    condition: sample.condition,
    provider_requests: score.requestCount,
    token_usage: score.usage,
    estimated_cost_usd: score.cost.estimated,
    v2: score.v2,
  })
  const evaluated = await execChecked(PYTHON, [
    join(MODELTEST, 'evaluator', 'run_full_eval.py'), candidateProject,
    '--model', ROUTE.model,
    '--channel', ROUTE.provider,
    '--harness', `dsh-${sample.condition}`,
    '--require-meta', '--include-espidf-build',
    '--run-group-id', `dsv4-v2-${platformSlug()}-${sample.condition}-max`,
    '--run-index', '1', '--thinking-level', ROUTE.reasoningEffort,
    '--provider', ROUTE.provider, '--endpoint-product', 'deepseek-api',
    '--meta-extra', metaExtra,
  ], { cwd: MODELTEST, allowFailure: true })
  await writeTextSecure(join(runDir, 'project2', sample.id, 'evaluator.stdout.log'), evaluated.stdout)
  await writeTextSecure(join(runDir, 'project2', sample.id, 'evaluator.stderr.log'), evaluated.stderr)
  const created = (await resultDirectories()).filter(name => !before.has(name))
  if (created.length !== 1) throw new Error(`${sample.id}: evaluator created ${created.length} result directories`)
  const source = join(MODELTEST, 'evaluator', 'results', created[0])
  const target = join(runDir, 'project2', sample.id, 'official')
  await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  const summary = await readJson(join(target, 'summary.json'))
  const draft = await readJson(join(target, 'score_draft.json')).catch(() => ({}))
  const blockers = await readJson(join(target, 'blockers.json')).catch(() => ({}))
  return {
    id: sample.id,
    condition: sample.condition,
    officialScore: draft.ability_draft ?? summary.ability_draft ?? null,
    shipDraft: draft.ship_draft ?? summary.ship_draft ?? null,
    releaseClassHint: draft.release_class_hint ?? summary.release_class_hint ?? null,
    blockers: blockers.final ?? summary.blockers ?? [],
    behaviorBlockers: blockers.behavior_blockers ?? summary.behavior_blockers ?? [],
    familyDraft: draft.family_draft ?? summary.family_draft ?? {},
    dimensions: summary.dimensions ?? {},
    evaluatorExitCode: evaluated.code,
    providerRequests: score.requestCount,
    tokenUsage: score.usage,
    estimatedCostUsd: score.cost.estimated,
    durationSec: summary.duration_sec ?? null,
    resultDir: relative(runDir, target).replaceAll('\\', '/'),
  }
}

function selectWinner(scores) {
  const ranked = [...scores].sort((a, b) => {
    const aKey = [a.firstCompliant ? 0 : 1, a.v2.guardDenialCount, a.firstBreadth, a.firstReasoningChars, a.cost.estimated]
    const bKey = [b.firstCompliant ? 0 : 1, b.v2.guardDenialCount, b.firstBreadth, b.firstReasoningChars, b.cost.estimated]
    for (let index = 0; index < aKey.length; index++) if (aKey[index] !== bKey[index]) return aKey[index] - bKey[index]
    return a.condition.localeCompare(b.condition)
  })
  const winner = ranked[0]
  return {
    method: 'lexicographic: intent compliance, guard denials, breadth, reasoning chars, estimated cost',
    winner: winner.condition,
    preset: PRESETS[winner.condition],
    eligibleForLongRun: winner.firstCompliant
      && winner.firstBreadth <= 1
      && winner.v2.promotedAfterQualifiedResult
      && winner.v2.prohibitedTools.length === 0,
    ranking: ranked.map(row => ({ condition: row.condition, firstCompliant: row.firstCompliant, firstBreadth: row.firstBreadth, guardDenials: row.v2.guardDenialCount, reasoningChars: row.firstReasoningChars, estimatedCostUsd: row.cost.estimated })),
  }
}

async function reportText(manifest, scores, projects, selection) {
  const lines = ['# DSV4 V2 省 Token 实验', '', `生成时间：${new Date().toISOString()}`, '']
  lines.push('## 设计', '', '- 复用既有 Standard 与原 Anchored 结果，不重跑基线。', '- 新增两次三步短探针；只让胜者进入一次完整 Project2。', '- 首轮 read + native shell；成功的合格 tool/result 后恢复 read/shell/edit/write/grep/glob。', '- 首轮递归枚举、后台任务和第三个并行调用由运行时 guard 拒绝。', '- web、todo、job、subagent、workflow 始终不进入 V2 模型工具目录。', '')
  if (scores.length) {
    lines.push('## 轨迹', '', '| 条件 | 首步 reasoning 字符 | 首步调用 | 广度 | 合规 | Guard 拒绝 | 晋级 | 请求数 | reasoning tokens | 费用 USD |', '|---|---:|---:|---:|---|---:|---|---:|---:|---:|')
    for (const row of scores) lines.push(`| ${row.condition} | ${row.firstReasoningChars} | ${row.firstToolCallCount} | ${row.firstBreadth} | ${row.firstCompliant} | ${row.v2.guardDenialCount} | ${row.v2.promotedAfterQualifiedResult} | ${row.requestCount} | ${row.usage.reasoningTokens ?? ''} | ${row.cost.estimated} |`)
    lines.push('')
  }
  if (selection) lines.push('## 短探针选择', '', `胜者：**${selection.winner}**；允许长测：**${selection.eligibleForLongRun}**。`, '', '```json', JSON.stringify(selection.ranking, null, 2), '```', '')
  if (projects.length) {
    lines.push('## Project2 官方评分', '', '| 条件 | Ability | Ship | Release | Blockers | 请求数 | reasoning tokens | 费用 USD |', '|---|---:|---:|---|---|---:|---:|---:|')
    for (const row of projects) lines.push(`| ${row.condition} | ${row.officialScore} | ${row.shipDraft} | ${row.releaseClassHint} | ${(row.blockers ?? []).join(', ')} | ${row.providerRequests} | ${row.tokenUsage.reasoningTokens ?? ''} | ${row.estimatedCostUsd} |`)
    lines.push('')
  }
  if (manifest.baselineRun && await pathExists(join(manifest.baselineRun, 'project2-results.json'))) {
    const baseline = (await readJson(join(manifest.baselineRun, 'project2-results.json'))).find(row => row.condition === 'standard-full')
    const candidate = projects[0]
    if (baseline && candidate) {
      lines.push('## 与既有 Standard 对比', '', `- Ability：${baseline.officialScore} → ${candidate.officialScore}（${candidate.officialScore - baseline.officialScore >= 0 ? '+' : ''}${candidate.officialScore - baseline.officialScore}）`, `- Ship：${baseline.shipDraft} → ${candidate.shipDraft}（${candidate.shipDraft - baseline.shipDraft >= 0 ? '+' : ''}${candidate.shipDraft - baseline.shipDraft}）`, `- 请求数：${baseline.providerRequests} → ${candidate.providerRequests}（${candidate.providerRequests - baseline.providerRequests >= 0 ? '+' : ''}${candidate.providerRequests - baseline.providerRequests}）`, `- 费用：${baseline.estimatedCostUsd} → ${candidate.estimatedCostUsd} USD`, `- 新增 blockers：${(candidate.blockers ?? []).filter(item => !(baseline.blockers ?? []).includes(item)).join(', ') || '无'}`, '')
    }
  }
  lines.push('## 首三次调用原文', '')
  for (const row of scores) {
    lines.push(`### ${row.id}`, '', `完整题面与哈希保存在 scores.json；prompt SHA-256：\`${row.promptSha256}\`。`, '')
    for (const message of row.firstThree) {
      lines.push(`#### Assistant ${message.index}`, '', '**Reasoning**', '', '```text', message.reasoning || '(empty)', '```', '', '**Tool calls**', '', '```json', JSON.stringify(message.toolCalls, null, 2), '```', '')
    }
  }
  return `${lines.join('\n')}\n`
}

async function live(suite, conditions, baselineRun) {
  await preflight()
  const runId = `run-${platformSlug()}-${suite}-${stamp()}`
  const runDir = join(here, 'runs', runId)
  await mkdir(runDir, { recursive: true })
  const manifest = await baseManifest(runId, suite, baselineRun)
  const scores = []
  const projectResults = []
  const prompt = extractCandidatePrompt(await readFile(join(MODELTEST, 'CANDIDATE_PROMPT.md'), 'utf8'))
  const approval = new ApprovalDriver(manifest)
  await approval.start()
  try {
    for (const [index, condition] of conditions.entries()) {
      const isProbe = suite !== 'project2'
      const sample = { id: `${suite}-${index + 1}-${condition}`, suite: isProbe ? 'probe' : 'project2', condition, preset: PRESETS[condition], repeat: 1 }
      const prepared = await prepareHandoff(sample, runDir)
      const prefix = suite === 'micro-v6'
        ? PREFETCH_MICRO_SESSION_PREFIX
        : suite === 'micro-v5'
        ? NOTED_READ_MICRO_SESSION_PREFIX
        : suite === 'micro-v4'
        ? READ_MICRO_SESSION_PREFIX
        : suite === 'micro'
          ? MICRO_SESSION_PREFIX
          : suite === 'probe'
            ? PROBE_SESSION_PREFIX
            : PROJECT_SESSION_PREFIX
      const sessionId = `${prefix}${platformSlug()}-${runId}-${sample.id}`
      const eventFile = `events/${sample.id}.jsonl`
      const record = { ...sample, platform: PLATFORM, sessionId, prompt, sentAt: null, eventFile, workspace: prepared.output, handoffSha256: prepared.handoffSha256 }
      console.log(`[${suite}] ${condition} -> ${sessionId}`)
      try {
        const result = await runSession({ sessionId, title: `DSV4 V2 ${suite} ${condition}`, cwd: agentPath(prepared.output), preset: sample.preset, prompt, timeoutMs: isProbe ? 600_000 : 3_600_000 })
        record.sentAt = result.sentAt
        await writeEvents(join(runDir, eventFile), result.events)
        const terminalError = result.events.find(event => event.type === 'turn/end' && event.data?.reason?.kind === 'error')
        const expectedMicroStop = (suite === 'micro' && /V3_SINGLE_REQUEST_STOP/.test(JSON.stringify(terminalError?.data?.reason ?? '')))
          || (suite === 'micro-v4' && /V4_SINGLE_REQUEST_STOP/.test(JSON.stringify(terminalError?.data?.reason ?? '')))
          || (suite === 'micro-v5' && /V4_SINGLE_REQUEST_STOP/.test(JSON.stringify(terminalError?.data?.reason ?? '')))
          || (suite === 'micro-v6' && /V6_SINGLE_REQUEST_STOP/.test(JSON.stringify(terminalError?.data?.reason ?? '')))
        if (terminalError && !expectedMicroStop) throw new Error(`provider error: ${JSON.stringify(terminalError.data?.reason)}`)
        const score = scoreV2(record, result.events)
        scores.push(score)
        if (!isProbe) projectResults.push(await evaluateProject(sample, join(prepared.output, 'project2_task'), runDir, score))
        manifest.samples.push(record)
        await save(runDir, manifest, scores, projectResults)
      } catch (error) {
        manifest.failures.push({ id: sample.id, error: String(error?.message ?? error), failedAt: new Date().toISOString() })
        await save(runDir, manifest, scores, projectResults)
        throw error
      }
    }
  } finally { approval.close() }
  const selection = suite !== 'project2' ? selectWinner(scores) : undefined
  manifest.secretScan = await scanTreeForSecrets(runDir)
  await save(runDir, manifest, scores, projectResults, selection)
  console.log(`[done] ${runDir}`)
}

async function replay(runDir) {
  const manifest = await readJson(join(runDir, 'manifest.json'))
  const scores = []
  for (const sample of manifest.samples) scores.push(scoreV2(sample, await readEvents(join(runDir, sample.eventFile))))
  const previous = await readFile(join(runDir, 'scores.json'), 'utf8')
  const next = canonicalJson(scores, 2)
  if (previous !== next) {
    await writeTextSecure(join(runDir, 'scores.replay-mismatch.json'), next)
    throw new Error(`REPLAY_MISMATCH: ${sha256(previous)} != ${sha256(next)}`)
  }
  const projects = await readJson(join(runDir, 'project2-results.json')).catch(() => [])
  const selection = await readJson(join(runDir, 'selection.json')).catch(() => undefined)
  await save(runDir, manifest, scores, projects, selection)
  await writeJson(join(runDir, 'replay.json'), { modelRequests: 0, scoresByteIdentical: true, scoresSha256: sha256(next), replayedAt: new Date().toISOString() })
  console.log(`[replay] ${sha256(next)}`)
}

async function applyEffectGate(runDir, standardRun) {
  const manifest = await readJson(join(runDir, 'manifest.json'))
  const scores = await readJson(join(runDir, 'scores.json'))
  const projects = await readJson(join(runDir, 'project2-results.json')).catch(() => [])
  const selection = await readJson(join(runDir, 'selection.json'))
  const standards = await readJson(join(resolve(standardRun), 'scores.json'))
  const baseline = standards.find(row => row.condition === 'standard-full' && row.suite === 'probe')
    ?? standards.find(row => row.condition === 'standard-full')
  const candidate = scores.find(row => row.condition === selection.winner)
  if (!baseline || !candidate) throw new Error('effect gate requires Standard and selected candidate scores')
  const effectGate = {
    rule: 'candidate first reasoning chars < Standard and candidate first breadth < Standard',
    standardRun: resolve(standardRun),
    standardReasoningChars: baseline.firstReasoningChars,
    candidateReasoningChars: candidate.firstReasoningChars,
    standardBreadth: baseline.firstBreadth,
    candidateBreadth: candidate.firstBreadth,
    passed: candidate.firstReasoningChars < baseline.firstReasoningChars
      && candidate.firstBreadth < baseline.firstBreadth,
  }
  const micro = String(manifest.suite).startsWith('micro')
  const microBudget = candidate.condition === 'v6-prefetched-core' ? 2 : 1
  const structuralGate = candidate.firstCompliant
    && candidate.firstBreadth <= 1
    && candidate.v2.prohibitedTools.length === 0
    && (micro ? candidate.requestCount === 1 && candidate.firstToolCallCount <= microBudget : candidate.v2.promotedAfterQualifiedResult)
  effectGate.structuralPassed = structuralGate
  effectGate.promotionCheckedByRuntimeSmoke = micro
  selection.effectGate = effectGate
  selection.eligibleForLongRun = structuralGate && effectGate.passed
  await save(runDir, manifest, scores, projects, selection)
  console.log(`[gate] eligible=${selection.eligibleForLongRun} ${JSON.stringify(effectGate)}`)
}

if (mode === 'probe-live') {
  await live('probe', ['v2-minimal-core', 'v2-compact-core'])
} else if (mode === 'micro-v3-live') {
  await live('micro', ['v3-single-core'])
} else if (mode === 'micro-v4-live') {
  await live('micro-v4', ['v4-read-core'])
} else if (mode === 'micro-v5-live') {
  await live('micro-v5', ['v5-read-noted-core'])
} else if (mode === 'micro-v6-live') {
  await live('micro-v6', ['v6-prefetched-core'])
} else if (mode === 'project2-live') {
  const probeRun = option('--probe-run')
  const baselineRun = option('--baseline-run')
  if (!probeRun || !baselineRun) throw new Error('project2-live requires --probe-run and --baseline-run')
  const selection = await readJson(join(resolve(probeRun), 'selection.json'))
  if (selection.effectGate?.passed !== true) throw new Error('short-run effect gate is missing or failed')
  if (!selection.eligibleForLongRun) throw new Error(`winner ${selection.winner} did not pass the short gate`)
  await live('project2', [selection.winner], baselineRun)
} else if (mode === 'gate') {
  const run = option('--run')
  const standardRun = option('--standard-run')
  if (!run || !standardRun) throw new Error('gate requires --run and --standard-run')
  await applyEffectGate(resolve(run), standardRun)
} else if (mode === 'replay') {
  const run = option('--run')
  if (!run) throw new Error('replay requires --run')
  await replay(resolve(run))
} else {
  throw new Error('usage: runner.mjs probe-live | micro-v3-live | micro-v4-live | micro-v5-live | micro-v6-live | gate --run DIR --standard-run DIR | project2-live --probe-run DIR --baseline-run DIR | replay --run DIR')
}
