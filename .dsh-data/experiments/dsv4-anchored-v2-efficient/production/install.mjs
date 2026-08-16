#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERSONA } from './progressive-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve(process.env.DSH_PRESET_ROOT ?? join(here, '..', '..', '..', '.agent-presets'))
const presetId = 'dsv4-progressive-guarded'
const target = join(presetRoot, presetId)

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function standardPathFor(root) {
  const candidates = [
    join(root, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
    join(root, 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  throw new Error(`could not find Standard agent.cordis.yml under ${root}; tried:\n${candidates.join('\n')}`)
}

const standardPath = await standardPathFor(sourceRoot)

const persona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: ${JSON.stringify(PERSONA)}
    complete: true
    includeRuntimeContext: false
`

function composition(standard) {
  const personaStart = standard.indexOf('- id: persona')
  const personaEnd = standard.indexOf('\n- id: agent-instructions', personaStart)
  if (personaStart < 0 || personaEnd < 0) throw new Error('could not locate Standard persona')
  const minimal = `${standard.slice(0, personaStart)}${persona}${standard.slice(personaEnd + 1)}`
  const shell = minimal.indexOf('\n- id: tool-bash')
  const filesystem = minimal.indexOf('\n# ── filesystem', shell)
  if (shell < 0 || filesystem < 0) throw new Error('could not locate Standard shell block')
  const plugin = `
# Stable Pro request prefix and runtime containment.
- id: dsv4-progressive-guard
  name: './progressive-guard.mjs'
  config:
    modelPolicy: pro
    shellTools: [bash]
    bootstrapTools: [read]
    coreTools: [read, edit, write, grep, glob]
    maxFirstStepCalls: 2
    bootstrapMaxEntries: 50
    blockBroadInventory: true
    blockInternalContext: true
    blockBootstrapWrites: true
    blockShellContentWrites: true
    maxMutationChars: 12000
    maxUnverifiedMutationChars: 24000
    maxMutationsPerStep: 2
    maxPostCheckCalls: 2
    maxPostPassMutations: 1
    maxPostPassDiagnostics: 2
    maxCallsWithoutProgress: 16
    maxEnvironmentFailuresPerCheck: 2
    maxTotalToolCalls: 80
    maxAssistantSteps: 64
    repeatLimit: 2
    requestMaxTokens: 8192
`
  const portableBash = `
# Windows keeps DSH's native pwsh executor and ACL sandbox. This agent-local
# facade only normalizes a small, portable command surface to the model's
# Linux-heavy training distribution; it does not install or launch Git Bash.
- id: dsv4-portable-bash-windows
  name: './portable-bash.mjs'
  disabled: !!js process.platform !== 'win32'
  config:
    maxProbeEntries: 50
`
  const guarded = `${minimal.slice(0, shell)}${plugin}${minimal.slice(shell)}`
  const guardedFilesystem = guarded.indexOf('\n# ── filesystem', shell + plugin.length)
  return `${guarded.slice(0, guardedFilesystem)}${portableBash}${guarded.slice(guardedFilesystem)}`
}

const standard = await readFile(standardPath, 'utf8')
await mkdir(target, { recursive: true })
await writeFile(join(target, 'agent.cordis.yml'), composition(standard), 'utf8')
await writeFile(join(target, 'preset.yml'), `name: DSV4 Progressive Guarded\ndescription: Stable Pro context and tool schema with bounded vertical slices, reliable checks, and convergence control.\norder: 20\n`, 'utf8')
await copyFile(join(here, 'progressive-guard.mjs'), join(target, 'progressive-guard.mjs'))
await copyFile(join(here, 'model-policy.mjs'), join(target, 'model-policy.mjs'))
await copyFile(join(here, 'portable-bash.mjs'), join(target, 'portable-bash.mjs'))
await copyFile(join(here, 'README.md'), join(target, 'README.md'))
console.log(JSON.stringify({ presetId, target, standardPath }, null, 2))
