#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runArgument = process.argv[2]
  ?? (await readFile(join(here, 'latest-run.txt'), 'utf8')).trim()
const runDir = isAbsolute(runArgument) ? resolve(runArgument) : resolve(here, runArgument)
const scores = JSON.parse(await readFile(join(runDir, 'scores.json'), 'utf8'))
const evaluations = JSON.parse(await readFile(join(runDir, 'evaluations.json'), 'utf8'))

function parseEvents(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function messageContent(event) {
  const value = event?.data?.message?.content ?? event?.data?.content
  return Array.isArray(value) ? value : []
}

function argumentsOf(value) {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) } catch { return { raw: value } }
}

function blockText(block) {
  if (typeof block?.text === 'string') return block.text
  if (typeof block?.content === 'string') return block.content
  if (Array.isArray(block?.content)) return block.content.map(blockText).join('\n')
  return JSON.stringify(block?.content ?? '')
}

function resultText(event) {
  return messageContent(event).map(blockText).join('\n')
}

function isSuccess(event) {
  if (event?.type !== 'tool/result') return false
  if (event.data?.isError === true) return false
  const resultBlock = messageContent(event).find(block => block?.type === 'tool-result')
  if (resultBlock?.isError === true) return false
  const text = resultText(event)
  if (/\[exit code:\s*[1-9]\d*\]/i.test(text)) return false
  if (/\b(?:exitcode|exit|public_tests|debug_probe|tests|probe)\s*=\s*(?!0\b)\d+/i.test(text)) return false
  if (/PROGRESSIVE_[A-Z_]+/.test(text)) return false
  if (/(?:^|\r?\n)\s*(?:FAILED|ERROR|FATAL)(?::|\s|$)/im.test(text)) return false
  return true
}

function commandKind(command) {
  const value = String(command ?? '')
  const pythonInvocation = String.raw`(?:python(?:\.exe)?|py(?:\.exe)?|&\s*(?:\$[A-Za-z_]\w*|['"][^'"]*python\.exe['"]))`
  const invokes = script => new RegExp(String.raw`(?:^|[;\r\n])\s*${pythonInvocation}[^;\r\n]*${script}`, 'i').test(value)
  if (invokes(String.raw`run_public_tests\.py`)) return 'public-tests'
  if (invokes(String.raw`run_debug_probe\.py`)) return 'debug-probe'
  if (invokes(String.raw`run_espidf_(?:wsl_)?build`) || /(?:^|[;\r\n])\s*idf\.py\s+build/i.test(value)) return 'espidf-build'
  if (/git\s+(?:diff|status)/i.test(value)) return 'git-review'
  return null
}

function analyzeEvents(events) {
  const assistants = events.filter(event => event.type === 'assistant/message')
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  const resultByCall = new Map()
  for (const event of results) {
    const block = messageContent(event).find(candidate => candidate?.type === 'tool-result')
    const id = block?.toolCallId ?? event.data?.callId
    if (id) resultByCall.set(id, event)
  }

  let header = null
  const hiddenSchemaCalls = []
  const assistantByCall = new Map()
  assistants.forEach((event, assistantIndex) => {
    for (const block of messageContent(event).filter(candidate => candidate?.type === 'tool-call')) {
      assistantByCall.set(block.id, assistantIndex + 1)
    }
  })
  for (const event of events) {
    if (event.type === 'request/header') header = event.data?.header ?? {}
    if (event.type !== 'assistant/message') continue
    const visible = new Set((header?.tools ?? []).map(tool => tool.name))
    for (const block of messageContent(event).filter(candidate => candidate?.type === 'tool-call')) {
      const name = String(block.name ?? block.toolName ?? '')
      if (!visible.has(name)) hiddenSchemaCalls.push({ assistant: assistants.indexOf(event) + 1, name, id: block.id })
    }
  }

  const callsDetailed = calls.map(event => {
    const args = argumentsOf(event.data?.arguments)
    const result = resultByCall.get(event.data?.callId)
    const command = args.command
    const fullResult = result ? resultText(result) : ''
    return {
      seq: event.seq ?? null,
      assistant: assistantByCall.get(event.data?.callId) ?? null,
      id: event.data?.callId ?? null,
      name: event.data?.name ?? null,
      args,
      commandKind: commandKind(command),
      resultSeq: result?.seq ?? null,
      success: result ? isSuccess(result) : null,
      fullResult,
      resultExcerpt: fullResult.slice(0, 500),
    }
  })
  const mutations = callsDetailed.filter(call => call.name === 'write' || call.name === 'edit')
  const checks = callsDetailed.filter(call => call.commandKind !== null)
  const successfulAcceptance = checks.filter(call => {
    if (!call.success) return false
    const text = call.fullResult
    if (call.commandKind === 'public-tests') {
      return /all public tests passed|public_tests(?:_exit)?=0|tests exit=0/i.test(text)
    }
    if (call.commandKind === 'debug-probe') {
      return /all visible diagnostic checks passed|debug_probe(?:_exit)?=0|probe exit=0/i.test(text)
    }
    if (call.commandKind === 'espidf-build') return /Project build complete|\bEXIT=0\b/i.test(text)
    return false
  })
  const lastAcceptance = successfulAcceptance.at(-1)
  const callsAfterLastAcceptance = lastAcceptance === undefined
    ? null
    : callsDetailed.filter(call => Number(call.seq) > Number(lastAcceptance.resultSeq ?? lastAcceptance.seq)).length
  const denialCodes = {}
  const denialExamples = []
  for (const event of results) {
    const codes = resultText(event).match(/PROGRESSIVE_[A-Z_]+/g) ?? []
    for (const code of codes) {
      denialCodes[code] = (denialCodes[code] ?? 0) + 1
    }
    if (codes.length > 0) {
      const block = messageContent(event).find(candidate => candidate?.type === 'tool-result')
      const call = callsDetailed.find(candidate => candidate.id === (block?.toolCallId ?? event.data?.callId))
      denialExamples.push({ assistant: call?.assistant ?? null, name: call?.name ?? null, arguments: call?.args ?? {}, codes: [...new Set(codes)] })
    }
  }
  const first = assistants[0]
  const start = events.find(event => event.type === 'step/start')?.time
  const end = events.findLast(event => event.type === 'turn/end')?.time
  const headers = events.filter(event => event.type === 'request/header')
  return {
    assistants: assistants.length,
    toolCalls: calls.length,
    toolCallsByName: Object.fromEntries([...new Set(calls.map(event => event.data?.name ?? 'unknown'))]
      .sort().map(name => [name, calls.filter(event => (event.data?.name ?? 'unknown') === name).length])),
    elapsedSec: Number.isFinite(start) && Number.isFinite(end) ? Number(((end - start) / 1000).toFixed(3)) : null,
    headers: headers.map(event => {
      const tools = event.data?.header?.tools ?? []
      return {
        seq: event.seq ?? null,
        reason: event.data?.reason ?? null,
        systemChars: String(event.data?.header?.system ?? '').length,
        toolCount: tools.length,
        toolNames: tools.map(tool => tool.name),
        schemaBytes: Buffer.byteLength(JSON.stringify(tools)),
        shellSchemaBytes: Buffer.byteLength(JSON.stringify(tools.find(tool => tool.name === 'pwsh') ?? {})),
      }
    }),
    hiddenSchemaCalls,
    firstReasoning: messageContent(first).filter(block => block.type === 'reasoning').map(blockText).join('\n'),
    firstToolCalls: messageContent(first).filter(block => block.type === 'tool-call').map(block => ({
      id: block.id,
      name: block.name ?? block.toolName,
      arguments: argumentsOf(block.arguments ?? block.input ?? block.args),
    })),
    mutations: {
      count: mutations.length,
      firstAssistant: mutations[0]?.assistant ?? null,
      byName: Object.fromEntries(['write', 'edit'].map(name => [name, mutations.filter(call => call.name === name).length])),
      files: [...new Set(mutations.map(call => call.args.file_path ?? call.args.path).filter(Boolean))],
      largestGeneratedArgumentChars: Math.max(0, ...mutations.map(call => Math.max(
        String(call.args.content ?? '').length,
        String(call.args.new_string ?? '').length,
      ))),
    },
    checks: checks.map(call => ({
      assistant: call.assistant,
      kind: call.commandKind,
      success: call.success,
      command: call.args.command,
      resultExcerpt: call.resultExcerpt,
    })),
    successfulAcceptanceChecks: successfulAcceptance.length,
    callsAfterLastSuccessfulAcceptance: callsAfterLastAcceptance,
    denialCodes,
    denialExamples,
    terminal: events.findLast(event => event.type === 'turn/end')?.data?.reason ?? null,
  }
}

function summarizeTests(report) {
  const failedTests = []
  for (const file of report.files ?? []) {
    for (const record of file.records ?? []) {
      if (record.status === 'passed') continue
      failedTests.push({ file: file.file, test: record.test, status: record.status, message: record.message ?? '' })
    }
  }
  return {
    testsRun: report.tests_run ?? null,
    passed: report.passed ?? null,
    failed: report.failed ?? null,
    errors: report.errors ?? null,
    skipped: report.skipped ?? null,
    families: report.families ?? undefined,
    failedTests,
  }
}

const analyses = []
for (const score of scores) {
  const conditionDir = join(runDir, 'conditions', score.condition)
  const events = parseEvents(await readFile(join(conditionDir, 'events.jsonl'), 'utf8'))
  const hidden = JSON.parse(await readFile(join(conditionDir, 'official', 'hidden_summary.json'), 'utf8'))
  const espStatic = JSON.parse(await readFile(join(conditionDir, 'official', 'espidf_static_summary.json'), 'utf8'))
  const espBuild = JSON.parse(await readFile(join(conditionDir, 'official', 'espidf_build_evidence.json'), 'utf8'))
  const status = (await readFile(join(conditionDir, 'official', 'candidate_status.txt'), 'utf8')).trim()
  const patch = await readFile(join(conditionDir, 'official', 'candidate_diff.patch'), 'utf8')
  const evaluation = evaluations.find(row => row.id === score.condition)
  analyses.push({
    condition: score.condition,
    completed: score.turnEndReason?.kind === 'completed',
    route: score.route,
    requests: score.requestCount,
    usage: score.usage,
    cache: score.cache,
    costUsd: score.cost.estimated,
    first: {
      systemChars: score.firstSystemChars,
      toolNames: score.firstToolNames,
      reasoningChars: score.firstReasoningChars,
      breadth: score.firstBreadth,
    },
    schemaStates: score.allRequestToolSchemaHashes.length,
    maxTokensSeen: score.maxTokensSeen,
    reasoningEffortSeen: score.reasoningEffortSeen,
    trajectory: analyzeEvents(events),
    evaluator: {
      ability: evaluation.ability,
      ship: evaluation.ship,
      releaseClass: evaluation.releaseClass,
      blockers: evaluation.blockers,
      family: evaluation.family,
      dimensions: evaluation.dimensions,
      candidateStatus: status ? status.split(/\r?\n/) : [],
      patchChars: patch.length,
      patchLines: patch ? patch.split(/\r?\n/).length : 0,
      hidden: summarizeTests(hidden),
      espStatic: summarizeTests(espStatic),
      espBuild: {
        status: espBuild.status ?? null,
        returnCode: espBuild.return_code ?? null,
        evidenceComplete: espBuild.evidence_complete ?? null,
        artifacts: espBuild.artifacts ?? [],
      },
    },
  })
}

const output = {
  runDir,
  generatedAt: new Date().toISOString(),
  comparableQuality: analyses.every(row => row.completed),
  analyses,
}
await writeFile(join(runDir, 'analysis.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
await writeFile(join(here, 'latest-analysis.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
