#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MINIMAL_SYSTEM } from './contract-anchor.mjs'

export { MINIMAL_SYSTEM }
export const PRESET_ID = 'dsv4-pro-contract-anchor'
export const RELEASE_VERSION = 'v0.3.0'

const here = dirname(fileURLToPath(import.meta.url))

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function composePreset(standard) {
  const personaStart = standard.indexOf('- id: persona')
  const personaEnd = standard.indexOf('\n- id: agent-instructions', personaStart)
  if (personaStart < 0 || personaEnd < 0) throw new Error('could not locate the Standard persona section')

  const persona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: ${MINIMAL_SYSTEM}
    complete: false
    includeRuntimeContext: false
`
  const minimal = `${standard.slice(0, personaStart)}${persona}${standard.slice(personaEnd + 1)}`
  const shellAnchor = '\n- id: tool-bash'
  const shellAt = minimal.indexOf(shellAnchor)
  if (shellAt < 0) throw new Error('could not locate the Standard shell tool section')

  const filter = `
# DeepSeek V4 Pro two-phase contract anchor. Request one exposes only the
# native shell and read. The next request restores Standard tools and adds one
# stable, short engineering contract for every remaining request in the turn.
- id: dsv4-pro-contract-anchor-tools
  name: './contract-anchor.mjs'
  config:
    shellTools: [bash, pwsh]
    commonTools: [read]
`
  const composed = `${minimal.slice(0, shellAt)}${filter}${minimal.slice(shellAt)}`
  return `# Generated from DSH Standard SHA-256 ${sha256(standard)}.\n${composed.trimEnd()}\n`
}

export async function install(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? process.env.DSH_SOURCE_ROOT ?? process.cwd())
  const dshHome = resolve(options.dshHome ?? process.env.DSH_TARGET_HOME ?? join(sourceRoot, '.dsh-data'))
  const standardPath = join(sourceRoot, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
  const target = join(dshHome, '.agent-presets', PRESET_ID)
  const standard = await readFile(standardPath, 'utf8')
  const composition = composePreset(standard)

  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'agent.cordis.yml'), composition, 'utf8')
  await writeFile(join(target, 'preset.yml'), [
    `name: DeepSeek V4 Pro Contract Anchor ${RELEASE_VERSION}`,
    'description: Minimal request-one anchor; full Standard tools plus a stable invariant/checklist contract after the first persisted tool call.',
    'order: 5',
    '',
  ].join('\n'), 'utf8')
  await copyFile(join(here, 'contract-anchor.mjs'), join(target, 'contract-anchor.mjs'))

  return {
    presetId: PRESET_ID,
    target,
    standardPath,
    standardSha256: sha256(standard),
    compositionSha256: sha256(composition),
    pluginSha256: sha256(await readFile(join(here, 'contract-anchor.mjs'), 'utf8')),
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await install(), null, 2))
}
