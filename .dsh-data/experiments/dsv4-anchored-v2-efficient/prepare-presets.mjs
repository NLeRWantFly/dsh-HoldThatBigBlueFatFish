#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPACT_CONTRACT,
  CAPABILITY_NOTE,
  CORE_TOOLS,
  MAX_PROBE_ASSISTANT_MESSAGES,
  MINIMAL_PERSONA,
  PRESETS,
  PROBE_SESSION_PREFIX,
  MICRO_SESSION_PREFIX,
  READ_MICRO_SESSION_PREFIX,
  NOTED_READ_MICRO_SESSION_PREFIX,
  PREFETCH_MICRO_SESSION_PREFIX,
  SINGLE_ACTION_CONTRACT,
} from './constants.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve(process.env.DSH_EXPERIMENT_PRESET_ROOT ?? join(here, '..', '..', '.agent-presets'))
const standardPath = join(sourceRoot, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function personaBlock(condition) {
  const text = condition === 'v2-compact-core'
    ? `${MINIMAL_PERSONA} ${COMPACT_CONTRACT}`
    : condition === 'v3-single-core'
      ? `${MINIMAL_PERSONA} ${SINGLE_ACTION_CONTRACT}`
      : condition === 'v5-read-noted-core'
        ? `${MINIMAL_PERSONA} ${CAPABILITY_NOTE}`
      : MINIMAL_PERSONA
  const complete = condition === 'v6-prefetched-core' ? 'false' : 'true'
  return `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: ${JSON.stringify(text)}
    complete: ${complete}
    includeRuntimeContext: false
`
}

function replacePersona(standard, condition) {
  const start = standard.indexOf('- id: persona')
  const end = standard.indexOf('\n- id: agent-instructions', start)
  if (start < 0 || end < 0) throw new Error('could not locate Standard persona')
  return `${standard.slice(0, start)}${personaBlock(condition)}${standard.slice(end + 1)}`
}

function insertPolicy(composition, condition) {
  const anchor = '\n- id: tool-bash'
  const at = composition.indexOf(anchor)
  if (at < 0) throw new Error('could not locate shell tool')
  const policy = condition === 'v6-prefetched-core'
    ? 'v6-prefetch-policy.mjs'
    : condition === 'v4-read-core' || condition === 'v5-read-noted-core'
    ? 'v4-policy.mjs'
    : condition === 'v3-single-core'
      ? 'v3-policy.mjs'
      : 'v2-policy.mjs'
  const singleRequestConfig = condition === 'v3-single-core'
    ? '    singleRequest: true\n'
    : condition === 'v4-read-core'
      ? `    singleRequestSessionPrefix: ${READ_MICRO_SESSION_PREFIX}\n`
      : condition === 'v5-read-noted-core'
        ? `    singleRequestSessionPrefix: ${NOTED_READ_MICRO_SESSION_PREFIX}\n`
      : condition === 'v6-prefetched-core'
        ? `    singleRequestSessionPrefix: ${PREFETCH_MICRO_SESSION_PREFIX}\n    prefetchPath: ONBOARDING_TODO.md\n    persona: ${JSON.stringify(MINIMAL_PERSONA)}\n`
    : ''
  const row = `
# Efficient V2 request filter, evidence promotion, and execution guard.
- id: dsv4-official-v2-policy
  name: './${policy}'
  config:
    shellTools: [bash, pwsh]
    bootstrapTools: [read]
    coreTools: [${CORE_TOOLS.join(', ')}]
${singleRequestConfig}`
  return `${composition.slice(0, at)}${row}${composition.slice(at)}`
}

function appendProbeStop(composition, condition) {
  const isMicro = condition === 'v3-single-core' || condition === 'v4-read-core' || condition === 'v5-read-noted-core' || condition === 'v6-prefetched-core'
  const prefix = condition === 'v6-prefetched-core'
    ? PREFETCH_MICRO_SESSION_PREFIX
    : condition === 'v5-read-noted-core'
    ? NOTED_READ_MICRO_SESSION_PREFIX
    : condition === 'v4-read-core'
      ? READ_MICRO_SESSION_PREFIX
      : isMicro
        ? MICRO_SESSION_PREFIX
        : PROBE_SESSION_PREFIX
  return `${composition.trimEnd()}

# Evaluation-only stop after three complete assistant messages.
- id: dsv4-official-v2-probe-stop
  name: './probe-stop.mjs'
  config:
    sessionPrefix: ${prefix}
    maxAssistantMessages: ${isMicro ? 1 : MAX_PROBE_ASSISTANT_MESSAGES}
`
}

async function writeIfChanged(path, content) {
  const previous = await readFile(path, 'utf8').catch(() => undefined)
  if (previous !== content) await writeFile(path, content, 'utf8')
}

const standard = await readFile(standardPath, 'utf8')
const generated = []
for (const [condition, presetId] of Object.entries(PRESETS)) {
  const directory = join(presetRoot, presetId)
  await mkdir(directory, { recursive: true })
  const composition = `# Generated V2 from DSH Standard at ${sha256(standard)}.\n${appendProbeStop(insertPolicy(replacePersona(standard, condition), condition), condition)}`
  await writeIfChanged(join(directory, 'agent.cordis.yml'), composition)
  await writeIfChanged(join(directory, 'preset.yml'), `name: DeepSeek V4 Efficient ${condition}\ndescription: Compact prompt, guarded evidence bootstrap, and core-tool restoration.\norder: 21\n`)
  await copyFile(join(here, 'plugins', 'v2-policy.mjs'), join(directory, 'v2-policy.mjs'))
  if (condition === 'v3-single-core') await copyFile(join(here, 'plugins', 'v3-policy.mjs'), join(directory, 'v3-policy.mjs'))
  if (condition === 'v4-read-core') await copyFile(join(here, 'plugins', 'v4-policy.mjs'), join(directory, 'v4-policy.mjs'))
  if (condition === 'v5-read-noted-core') await copyFile(join(here, 'plugins', 'v4-policy.mjs'), join(directory, 'v4-policy.mjs'))
  if (condition === 'v6-prefetched-core') await copyFile(join(here, 'plugins', 'v6-prefetch-policy.mjs'), join(directory, 'v6-prefetch-policy.mjs'))
  await copyFile(join(here, 'plugins', 'probe-stop.mjs'), join(directory, 'probe-stop.mjs'))
  generated.push({ condition, presetId, compositionSha256: sha256(composition) })
}

const record = { standardPath, standardSha256: sha256(standard), compactContractSha256: sha256(COMPACT_CONTRACT), presets: generated }
await writeIfChanged(join(here, 'generated-presets.json'), `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify({ presetRoot, ...record }, null, 2))
