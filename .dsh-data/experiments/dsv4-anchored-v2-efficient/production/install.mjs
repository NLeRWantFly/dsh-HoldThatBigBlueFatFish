#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve(process.env.DSH_PRESET_ROOT ?? join(here, '..', '..', '..', '.agent-presets'))
const presetId = 'dsv4-progressive-guarded'
const target = join(presetRoot, presetId)
const standardPath = join(sourceRoot, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')

const persona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: "You are a helpful software engineer assistant."
    complete: true
    includeRuntimeContext: false
`

function composition(standard) {
  const personaStart = standard.indexOf('- id: persona')
  const personaEnd = standard.indexOf('\n- id: agent-instructions', personaStart)
  if (personaStart < 0 || personaEnd < 0) throw new Error('could not locate Standard persona')
  const minimal = `${standard.slice(0, personaStart)}${persona}${standard.slice(personaEnd + 1)}`
  const shell = minimal.indexOf('\n- id: tool-bash')
  if (shell < 0) throw new Error('could not locate Standard shell tool')
  const plugin = `
# Production progressive disclosure and runtime containment.
- id: dsv4-progressive-guard
  name: './progressive-guard.mjs'
  config:
    shellTools: [bash, pwsh]
    bootstrapTools: [read]
    coreTools: [read, edit, write, grep, glob]
    maxFirstStepCalls: 2
    blockBroadInventory: true
    blockBootstrapWrites: true
    repeatLimit: 2
`
  return `${minimal.slice(0, shell)}${plugin}${minimal.slice(shell)}`
}

const standard = await readFile(standardPath, 'utf8')
await mkdir(target, { recursive: true })
await writeFile(join(target, 'agent.cordis.yml'), composition(standard), 'utf8')
await writeFile(join(target, 'preset.yml'), `name: DSV4 Progressive Guarded\ndescription: Minimal persona, read/shell bootstrap, evidence promotion, core tools, and runtime containment.\norder: 20\n`, 'utf8')
await copyFile(join(here, 'progressive-guard.mjs'), join(target, 'progressive-guard.mjs'))
await copyFile(join(here, 'README.md'), join(target, 'README.md'))
console.log(JSON.stringify({ presetId, target, standardPath }, null, 2))
