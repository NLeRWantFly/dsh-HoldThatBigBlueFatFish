#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const previousPath = join(here, '..', 'dsv4-anchored-v2-efficient', 'all-results.json')

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const previous = await readJson(previousPath)
const current = await readJson(join(here, 'latest-summary.json'))
const analysis = await readJson(join(here, 'latest-analysis.json'))
const historical = await readJson(join(here, 'historical-opencode.json'))

const currentRows = current.rows.map(row => {
  const detail = analysis.analyses.find(candidate => candidate.condition === row.condition)
  const completed = row.completed === true
  return {
    experiment: 'router-vs-progressive-modeltest',
    runId: current.runId,
    suite: 'modeltest-project2-v4.1b',
    platform: current.platform,
    condition: row.condition,
    provider: current.route.provider,
    model: current.route.model,
    reasoningEffort: current.route.reasoningEffort,
    status: completed ? 'complete' : row.scoreStatus,
    dataQuality: completed ? 'measured-complete' : 'measured-censored',
    systemChars: detail?.first?.systemChars ?? null,
    visibleToolCount: detail?.first?.toolNames?.length ?? null,
    firstReasoningChars: detail?.first?.reasoningChars ?? null,
    firstToolCallCount: detail?.trajectory?.firstToolCalls?.length ?? null,
    firstBreadth: detail?.first?.breadth ?? null,
    firstCalls: (detail?.trajectory?.firstToolCalls ?? []).map(call => call.name).join(' | '),
    requestCount: row.requests,
    toolCalls: row.toolCalls,
    mutationCalls: row.mutations,
    inputTokens: row.cacheMissInputTokens,
    cacheReadTokens: row.cacheHitInputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    estimatedCostUsd: row.estimatedCostUsd,
    ability: completed ? row.abilityDraft : null,
    ship: completed ? row.shipDraft : null,
    release: completed ? row.releaseClassHint : null,
    partialAbility: completed ? null : row.partialAbilityDraft,
    partialShip: completed ? null : row.partialShipDraft,
    partialRelease: completed ? null : row.partialReleaseClassHint,
    blockers: (row.blockers ?? []).join(';'),
    terminal: row.terminal ?? { kind: 'completed' },
  }
})

const priorRows = previous.rows.map(row => ({
  ...row,
  status: 'complete',
  dataQuality: 'measured-complete',
  toolCalls: null,
  mutationCalls: null,
  partialAbility: null,
  partialShip: null,
  partialRelease: null,
  terminal: { kind: 'completed' },
}))

const officialRows = [...priorRows, ...currentRows]
const sum = key => officialRows.reduce((total, row) => total + (Number(row[key]) || 0), 0)
const output = {
  schemaVersion: 1,
  generatedFrom: [
    '../dsv4-anchored-v2-efficient/all-results.json',
    'latest-summary.json',
    'latest-analysis.json',
    'historical-opencode.json',
  ],
  comparability: {
    officialApi: 'Rows share the official DeepSeek API route, but span different suites and are not pooled as a causal A/B unless the suite/prompt match.',
    opencodeGo: 'Merged into the evidence table at the user request, clearly labeled and excluded from official totals because it is an approximate, different-task historical sample.',
    censored: 'The progressive Modeltest row ended with HTTP 402 before mutation; its partial evaluator score is not a final quality score.',
  },
  totals: {
    officialRows: officialRows.length,
    officialCompletedRows: officialRows.filter(row => row.status === 'complete').length,
    officialCensoredRows: officialRows.filter(row => row.dataQuality === 'measured-censored').length,
    officialModelRequests: sum('requestCount'),
    officialCacheMissInputTokens: sum('inputTokens'),
    officialCacheReadTokens: sum('cacheReadTokens'),
    officialOutputTokens: sum('outputTokens'),
    officialReasoningTokens: sum('reasoningTokens'),
    officialEstimatedCostUsd: Number(sum('estimatedCostUsd').toFixed(8)),
    opencodeReportedRows: historical.rows.length,
  },
  rows: [...officialRows, ...historical.rows],
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const columns = [
  'experiment', 'runId', 'suite', 'platform', 'condition', 'provider', 'model',
  'reasoningEffort', 'status', 'dataQuality', 'requestCount', 'assistantSteps',
  'toolCalls', 'mutationCalls', 'inputTokens', 'cacheReadTokens', 'outputTokens',
  'outputTokensApprox', 'reasoningTokens', 'reasoningTokensApprox',
  'estimatedCostUsd', 'ability', 'ship', 'release', 'partialAbility', 'partialShip',
  'partialRelease', 'firstReasoningChars', 'firstStepReasoningTokensApprox',
  'firstBreadth', 'systemChars', 'visibleToolCount', 'blockers', 'notes',
]
const csv = [
  columns.join(','),
  ...output.rows.map(row => columns.map(column => csvCell(row[column])).join(',')),
].join('\n') + '\n'

await writeFile(join(here, 'combined-results.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
await writeFile(join(here, 'combined-results.csv'), csv, 'utf8')
process.stdout.write(`${JSON.stringify(output.totals, null, 2)}\n`)
