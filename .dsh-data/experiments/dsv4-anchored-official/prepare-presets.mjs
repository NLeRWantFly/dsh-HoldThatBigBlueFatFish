#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_PROBE_ASSISTANT_MESSAGES,
  MINIMAL_SYSTEM,
  PRESET_IDS,
  PROBE_SESSION_PREFIX,
} from './constants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve(process.env.DSH_EXPERIMENT_PRESET_ROOT ?? join(here, '..', '..', '.agent-presets'))
const standardPath = join(sourceRoot, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')

const minimalPersona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: ${MINIMAL_SYSTEM}
    complete: true
    includeRuntimeContext: false
`

const probeRow = `
# Evaluation-only cancellation after the third complete assistant message.
- id: dsv4-official-probe-stop
  name: './probe-stop.mjs'
  config:
    sessionPrefix: ${PROBE_SESSION_PREFIX}
    maxAssistantMessages: ${MAX_PROBE_ASSISTANT_MESSAGES}
`

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function replacePersona(standard) {
  const start = standard.indexOf('- id: persona')
  const end = standard.indexOf('\n- id: agent-instructions', start)
  if (start < 0 || end < 0) throw new Error('could not locate Standard persona section')
  return `${standard.slice(0, start)}${minimalPersona}${standard.slice(end + 1)}`
}

function insertFilter(composition, pluginFile, id) {
  const anchor = '\n- id: tool-bash'
  const at = composition.indexOf(anchor)
  if (at < 0) throw new Error('could not locate Standard shell tool section')
  const row = `
# Experiment-only model request tool-catalog filter.
- id: ${id}
  name: './${pluginFile}'
  config:
    shellTools: [bash, pwsh]
    commonTools: [read]
`
  return `${composition.slice(0, at)}${row}${composition.slice(at)}`
}

function compose(standard, condition) {
  let output = condition.startsWith('minimal-') ? replacePersona(standard) : standard
  if (condition.endsWith('-anchored')) output = insertFilter(output, 'anchored-tools.mjs', 'dsv4-official-anchored-tools')
  if (condition === 'minimal-fixed') output = insertFilter(output, 'fixed-tools.mjs', 'dsv4-official-fixed-tools')
  return `# Generated from DSH Standard at ${sha256(standard)}; regenerate with prepare-presets.mjs.\n${output.trimEnd()}\n${probeRow}`
}

async function writeIfChanged(path, content) {
  const previous = await readFile(path, 'utf8').catch(() => undefined)
  if (previous !== content) await writeFile(path, content, 'utf8')
}

const standard = await readFile(standardPath, 'utf8')
const records = []
for (const [condition, presetId] of Object.entries(PRESET_IDS)) {
  const directory = join(presetRoot, presetId)
  await mkdir(directory, { recursive: true })
  const composition = compose(standard, condition)
  await writeIfChanged(join(directory, 'agent.cordis.yml'), composition)
  await writeIfChanged(join(directory, 'preset.yml'), `name: DeepSeek V4 Official ${condition}\ndescription: Official API Git-style anchored ablation condition.\norder: 20\n`)
  await copyFile(join(here, 'plugins', 'probe-stop.mjs'), join(directory, 'probe-stop.mjs'))
  if (condition.endsWith('-anchored')) await copyFile(join(here, 'plugins', 'anchored-tools.mjs'), join(directory, 'anchored-tools.mjs'))
  if (condition === 'minimal-fixed') {
    await copyFile(join(here, 'plugins', 'anchored-tools.mjs'), join(directory, 'anchored-tools.mjs'))
    await copyFile(join(here, 'plugins', 'fixed-tools.mjs'), join(directory, 'fixed-tools.mjs'))
  }
  records.push({ condition, presetId, compositionSha256: sha256(composition) })
}

await writeIfChanged(join(here, 'generated-presets.json'), `${JSON.stringify({ standardPath, standardSha256: sha256(standard), presets: records }, null, 2)}\n`)
console.log(JSON.stringify({ presetRoot, standardPath, presets: records }, null, 2))
