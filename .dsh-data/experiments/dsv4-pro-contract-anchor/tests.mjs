#!/usr/bin/env node
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { CONTRACT_SYSTEM, hasDurableToolCall, phaseSystem, projectRequest } from './contract-anchor.mjs'
import { install, MINIMAL_SYSTEM, PRESET_ID, RELEASE_VERSION } from './install.mjs'

let sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
let standardPath = join(sourceRoot, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
let syntheticSource
try {
  await access(standardPath)
} catch {
  syntheticSource = await mkdtemp(join(tmpdir(), 'dsv4-contract-standard-'))
  sourceRoot = syntheticSource
  standardPath = join(sourceRoot, 'apps', 'cli', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
  await mkdir(join(standardPath, '..'), { recursive: true })
  await writeFile(standardPath, `preset:
- id: persona
  name: standard-persona
- id: agent-instructions
  name: standard-instructions
- id: tool-bash
  name: shell
- id: tool-pwsh
  name: pwsh
- id: tool-fs
  name: fs
- id: tool-fs-search
  name: search
- id: tool-jobs
  name: jobs
- id: tool-skill
  name: skill
- id: tool-goal
  name: goal
- id: tool-web
  name: web
`, 'utf8')
}
const persona = { name: 'deployment:persona', order: 0, text: MINIMAL_SYSTEM }
const tools = [
  { name: 'read', description: 'read', inputSchema: { type: 'object' } },
  { name: 'pwsh', description: 'shell', inputSchema: { type: 'object' } },
  { name: 'glob', description: 'glob', inputSchema: { type: 'object' } },
  { name: 'edit', description: 'edit', inputSchema: { type: 'object' } },
]
const assembled = Object.freeze({ sections: [persona], contexts: [], tools, variables: {} })

assert.equal(MINIMAL_SYSTEM.length, 46)
assert(CONTRACT_SYSTEM.length < 500)
assert.equal(hasDurableToolCall([{ type: 'tool/result' }]), false)
assert.equal(hasDurableToolCall([{ type: 'tool/call' }]), true)
assert.equal(phaseSystem([]), MINIMAL_SYSTEM)
assert.equal(phaseSystem([{ type: 'tool/result' }]), MINIMAL_SYSTEM)
assert.equal(phaseSystem([{ type: 'tool/call' }]), `${MINIMAL_SYSTEM}\n\n${CONTRACT_SYSTEM}`)

const first = projectRequest(assembled, [])
assert.deepEqual(first.tools.map(tool => tool.name), ['read', 'pwsh'])
assert.deepEqual(first.sections, [persona])

const resultOnly = projectRequest(assembled, [{ type: 'tool/result' }])
assert.deepEqual(resultOnly.tools.map(tool => tool.name), ['read', 'pwsh'])
assert.deepEqual(resultOnly.sections, [persona])

const promoted = projectRequest(assembled, [{ type: 'tool/call' }])
assert.equal(promoted.tools, tools, 'promotion changed a shared Standard tool schema')
assert.deepEqual(promoted.sections, [persona], 'tool projection unexpectedly changed prompt sections')
assert.deepEqual(projectRequest(assembled, [{ type: 'tool/call' }]), promoted, 'promoted assembly is not stable')

const temporary = await mkdtemp(join(tmpdir(), 'dsv4-pro-contract-anchor-'))
try {
  const record = await install({ sourceRoot, dshHome: temporary })
  assert.equal(record.presetId, PRESET_ID)
  assert.equal(RELEASE_VERSION, 'v0.3.0')
  const composition = await readFile(join(record.target, 'agent.cordis.yml'), 'utf8')
  const metadata = await readFile(join(record.target, 'preset.yml'), 'utf8')
  const standard = await readFile(standardPath, 'utf8')
  assert(composition.includes(`text: ${MINIMAL_SYSTEM}`))
  assert(composition.includes('complete: false'))
  assert(composition.includes('includeRuntimeContext: false'))
  assert.equal((composition.match(/id: dsv4-pro-contract-anchor-tools/g) ?? []).length, 1)
  assert.equal((composition.match(/progressive-guard|requestMaxTokens/g) ?? []).length, 0)
  assert(metadata.includes(`name: DeepSeek V4 Pro Contract Anchor ${RELEASE_VERSION}`))
  for (const id of ['tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill', 'tool-goal', 'tool-web']) {
    assert(composition.includes(`id: ${id}`), `missing Standard row ${id}`)
    assert(standard.includes(`id: ${id}`), `Standard source missing ${id}`)
  }
  assert.equal(
    await readFile(join(record.target, 'contract-anchor.mjs'), 'utf8'),
    await readFile(new URL('./contract-anchor.mjs', import.meta.url), 'utf8'),
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
  if (syntheticSource !== undefined) await rm(syntheticSource, { recursive: true, force: true })
}

console.log('dsv4-pro-contract-anchor tests passed')
