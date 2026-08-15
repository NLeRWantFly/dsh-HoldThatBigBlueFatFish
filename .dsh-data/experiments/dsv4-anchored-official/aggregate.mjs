#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { HERE, readJson, writeJson, writeTextSecure } from './lib.mjs'

const argv = process.argv.slice(2)
function option(name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const windowsDir = option('--windows')
const linuxDir = option('--linux')
if (!windowsDir || !linuxDir) throw new Error('usage: aggregate.mjs --windows <run-directory> --linux <run-directory> [--out <directory>]')

async function load(path) {
  const root = resolve(path)
  return {
    root,
    manifest: await readJson(join(root, 'manifest.json')),
    scores: await readJson(join(root, 'scores.json')),
    projects: await readJson(join(root, 'project2-results.json')),
    verification: await readJson(join(root, 'verification.json')).catch(() => undefined),
  }
}

const windows = await load(windowsDir)
const linux = await load(linuxDir)
if (windows.manifest.platform !== 'windows-native') throw new Error(`--windows run is ${windows.manifest.platform}`)
if (linux.manifest.platform !== 'linux-docker') throw new Error(`--linux run is ${linux.manifest.platform}`)

const output = resolve(option('--out') ?? join(HERE, 'comparisons', `compare-${Date.now()}`))
await mkdir(output, { recursive: true })
const runs = [windows, linux]
const rows = runs.flatMap(run => run.scores.map(score => ({ ...score, platform: run.manifest.platform })))
const projectRows = runs.flatMap(run => run.projects.map(result => ({ ...result, platform: run.manifest.platform })))
const totalCost = rows.reduce((sum, row) => sum + Number(row.cost?.estimated ?? 0), 0)
const lines = ['# Windows / Linux Git-style Anchored 对照', '']
lines.push('每个条件每个 OS 只有一个样本；以下仅报告描述性差异。', '')
lines.push('## 首步对照', '')
lines.push('| OS | 条件 | reasoning 字符 | 行动前叙述 | 调用数 | 广度 | 工具目录数 | 请求数 | 估算 USD |')
lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|')
for (const row of rows.filter(item => item.suite === 'probe')) {
  lines.push(`| ${row.platform} | ${row.condition} | ${row.firstReasoningChars} | ${row.firstNarrationCharsBeforeAction} | ${row.firstToolCallCount} | ${row.firstBreadth} | ${row.firstToolCount} | ${row.requestCount} | ${row.cost.estimated} |`)
}
lines.push('', '## 同 OS 主对照（Minimal Anchored − Standard）', '')
lines.push('| OS | Δreasoning | Δ行动前叙述 | Δ调用数 | Δ广度 | ΔAbility | ΔShip | Release Standard → Anchored | 新 blocker |')
lines.push('|---|---:|---:|---:|---:|---:|---:|---|---|')
for (const platform of ['windows-native', 'linux-docker']) {
  const standard = rows.find(row => row.platform === platform && row.suite === 'probe' && row.condition === 'standard-full')
  const anchored = rows.find(row => row.platform === platform && row.suite === 'probe' && row.condition === 'minimal-anchored')
  const standardProject = projectRows.find(row => row.platform === platform && row.condition === 'standard-full')
  const anchoredProject = projectRows.find(row => row.platform === platform && row.condition === 'minimal-anchored')
  const standardBlockers = new Set(standardProject?.blockers ?? [])
  const newBlockers = (anchoredProject?.blockers ?? []).filter(blocker => !standardBlockers.has(blocker))
  lines.push(`| ${platform} | ${anchored.firstReasoningChars - standard.firstReasoningChars} | ${anchored.firstNarrationCharsBeforeAction - standard.firstNarrationCharsBeforeAction} | ${anchored.firstToolCallCount - standard.firstToolCallCount} | ${anchored.firstBreadth - standard.firstBreadth} | ${Number(anchoredProject?.officialScore) - Number(standardProject?.officialScore)} | ${Number(anchoredProject?.shipDraft) - Number(standardProject?.shipDraft)} | ${standardProject?.releaseClassHint ?? ''} → ${anchoredProject?.releaseClassHint ?? ''} | ${newBlockers.join(', ')} |`)
}
lines.push('', '## 跨 OS 同条件差异（Linux − Windows）', '')
lines.push('| 条件 | Δreasoning | Δ行动前叙述 | Δ调用数 | Δ广度 | ΔAbility | ΔShip |')
lines.push('|---|---:|---:|---:|---:|---:|---:|')
for (const condition of ['standard-full', 'minimal-full', 'standard-anchored', 'minimal-fixed', 'minimal-anchored']) {
  const win = rows.find(row => row.platform === 'windows-native' && row.suite === 'probe' && row.condition === condition)
  const lin = rows.find(row => row.platform === 'linux-docker' && row.suite === 'probe' && row.condition === condition)
  const winProject = projectRows.find(row => row.platform === 'windows-native' && row.condition === condition)
  const linProject = projectRows.find(row => row.platform === 'linux-docker' && row.condition === condition)
  lines.push(`| ${condition} | ${lin.firstReasoningChars - win.firstReasoningChars} | ${lin.firstNarrationCharsBeforeAction - win.firstNarrationCharsBeforeAction} | ${lin.firstToolCallCount - win.firstToolCallCount} | ${lin.firstBreadth - win.firstBreadth} | ${winProject && linProject ? Number(linProject.officialScore) - Number(winProject.officialScore) : ''} | ${winProject && linProject ? Number(linProject.shipDraft) - Number(winProject.shipDraft) : ''} |`)
}
lines.push('', '## 验证状态与成本', '')
lines.push(`- Windows：structure=${windows.verification?.structureOk ?? 'not verified'}；effect=${windows.verification?.effectPass ?? 'not verified'}。`)
lines.push(`- Linux：structure=${linux.verification?.structureOk ?? 'not verified'}；effect=${linux.verification?.effectPass ?? 'not verified'}。`)
lines.push(`- 所有已记录模型请求估算费用合计：USD ${totalCost.toFixed(8)}。`)
lines.push('- 每个 OS 的完整前三次 reasoning、tool-call JSON、官方 family/dimensions/blockers 位于各自 `report.md`。', '')

const payload = {
  generatedAt: new Date().toISOString(),
  windowsRun: windows.root,
  linuxRun: linux.root,
  scores: rows,
  projectResults: projectRows,
  totalEstimatedCostUsd: Number(totalCost.toFixed(8)),
}
await writeJson(join(output, 'aggregate.json'), payload)
await writeTextSecure(join(output, 'report.md'), `${lines.join('\n')}\n`)
console.log(output)
