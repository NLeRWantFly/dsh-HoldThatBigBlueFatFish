#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MINIMAL_SYSTEM = 'You are a helpful software engineer assistant.'
export const PRESET_ID = 'dsv4-pro-anchored-96'
export const RELEASE_VERSION = 'v0.2'

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
    complete: true
    includeRuntimeContext: false
`
  const minimal = `${standard.slice(0, personaStart)}${persona}${standard.slice(personaEnd + 1)}`
  const shellAnchor = '\n- id: tool-bash'
  const shellAt = minimal.indexOf(shellAnchor)
  if (shellAt < 0) throw new Error('could not locate the Standard shell tool section')

  const filter = `
# DeepSeek V4 Pro request-one trajectory anchor. All tools remain registered;
# only the first API request is projected to the native shell plus read.
- id: dsv4-pro-anchored-96-tools
  name: './anchored-tools.mjs'
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
    `name: DeepSeek V4 Pro Anchored ${RELEASE_VERSION}`,
    'description: V4 Pro-specific Minimal anchor; native shell/read on request one and full Standard tools after the first persisted tool call.',
    'order: 4',
    '',
  ].join('\n'), 'utf8')
  await copyFile(join(here, 'anchored-tools.mjs'), join(target, 'anchored-tools.mjs'))

  return {
    presetId: PRESET_ID,
    target,
    standardPath,
    standardSha256: sha256(standard),
    compositionSha256: sha256(composition),
    pluginSha256: sha256(await readFile(join(here, 'anchored-tools.mjs'), 'utf8')),
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await install(), null, 2))
}
