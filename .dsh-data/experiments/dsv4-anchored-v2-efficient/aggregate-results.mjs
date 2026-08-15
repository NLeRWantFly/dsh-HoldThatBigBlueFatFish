#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const official = join(here, '..', 'dsv4-anchored-official', 'runs')
const sources = [
  { experiment: 'official-git-style', run: join(official, 'run-win-2026-08-15_03-12-05-652') },
  { experiment: 'official-project2', run: join(official, 'run-win-2026-08-15_03-15-41-067') },
  { experiment: 'efficient-v2', run: join(here, 'runs', 'run-win-probe-2026-08-15_06-10-23-199') },
  { experiment: 'efficient-v3', run: join(here, 'runs', 'run-win-micro-2026-08-15_06-22-58-480') },
  { experiment: 'efficient-v4', run: join(here, 'runs', 'run-win-micro-v4-2026-08-15_07-26-13-393') },
  { experiment: 'efficient-v5', run: join(here, 'runs', 'run-win-micro-v5-2026-08-15_07-29-28-445') },
  { experiment: 'efficient-v6', run: join(here, 'runs', 'run-win-micro-v6-2026-08-15_07-39-50-668') },
]

async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

function toolSummary(score) {
  return (score.firstToolCalls ?? []).map(call => {
    const args = call.arguments ?? {}
    const target = args.file_path ?? args.path ?? args.pattern ?? args.command ?? ''
    return `${call.name}${target ? `:${String(target).replace(/\s+/g, ' ').slice(0, 100)}` : ''}`
  }).join(' | ')
}

const rows = []
for (const source of sources) {
  const manifest = await json(join(source.run, 'manifest.json'), {})
  const scores = await json(join(source.run, 'scores.json'), [])
  const projects = await json(join(source.run, 'project2-results.json'), [])
  for (const score of scores) {
    const project = projects.find(row => row.id === score.id) ?? projects.find(row => row.condition === score.condition)
    rows.push({
      experiment: source.experiment,
      runId: manifest.runId ?? source.run.split(/[\\/]/).at(-1),
      suite: score.suite,
      platform: score.platform ?? manifest.platform,
      condition: score.condition,
      provider: score.route?.provider ?? manifest.route?.provider,
      model: score.route?.model ?? manifest.route?.model,
      reasoningEffort: score.route?.reasoningEffort ?? manifest.route?.reasoningEffort,
      systemChars: score.firstSystemChars,
      visibleToolCount: score.firstToolCount,
      firstReasoningChars: score.firstReasoningChars,
      firstNarrationChars: score.firstNarrationCharsBeforeAction,
      firstToolCallCount: score.firstToolCallCount,
      firstBreadth: score.firstBreadth,
      firstCompliant: score.firstCompliant,
      firstCalls: toolSummary(score),
      requestCount: score.requestCount,
      inputTokens: score.usage?.inputTokens ?? null,
      cacheReadTokens: score.usage?.cacheReadTokens ?? null,
      outputTokens: score.usage?.outputTokens ?? null,
      reasoningTokens: score.usage?.reasoningTokens ?? null,
      estimatedCostUsd: score.cost?.estimated ?? null,
      ability: project?.officialScore ?? null,
      ship: project?.shipDraft ?? null,
      release: project?.releaseClassHint ?? null,
      blockers: (project?.blockers ?? []).join(';'),
    })
  }
}

const attempts = [
  { runId: 'run-win-2026-08-15_03-10-55-462', status: 'empty setup attempt', scoredRows: 0 },
  { runId: 'run-win-2026-08-15_03-11-19-451', status: 'preflight artifact only', scoredRows: 0 },
]
const totals = {
  scoredRows: rows.length,
  modelRequests: rows.reduce((sum, row) => sum + Number(row.requestCount ?? 0), 0),
  inputTokens: rows.reduce((sum, row) => sum + Number(row.inputTokens ?? 0), 0),
  cacheReadTokens: rows.reduce((sum, row) => sum + Number(row.cacheReadTokens ?? 0), 0),
  outputTokens: rows.reduce((sum, row) => sum + Number(row.outputTokens ?? 0), 0),
  reasoningTokens: rows.reduce((sum, row) => sum + Number(row.reasoningTokens ?? 0), 0),
  estimatedCostUsd: Number(rows.reduce((sum, row) => sum + Number(row.estimatedCostUsd ?? 0), 0).toFixed(8)),
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const columns = Object.keys(rows[0])
const csv = [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\n') + '\n'
const payload = {
  schemaVersion: 1,
  generatedFrom: sources.map(source => `${source.experiment}/${source.run.split(/[\\/]/).at(-1)}`),
  attempts,
  totals,
  rows,
}
await writeFile(join(here, 'all-results.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
await writeFile(join(here, 'all-results.csv'), csv, 'utf8')
console.log(JSON.stringify(totals, null, 2))
