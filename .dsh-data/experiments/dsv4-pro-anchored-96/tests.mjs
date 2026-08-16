#!/usr/bin/env node
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { filterFirstRequest, hasDurableToolCall } from './anchored-tools.mjs'
import { install, MINIMAL_SYSTEM, PRESET_ID, RELEASE_VERSION } from './install.mjs'

const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())

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
const tools = [
  { name: 'read', description: 'read', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'pwsh', description: 'shell', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'glob', description: 'glob', inputSchema: { type: 'object' } },
  { name: 'edit', description: 'edit', inputSchema: { type: 'object' } },
]
const assembled = Object.freeze({ sections: [], contexts: [], tools, variables: {} })

assert.equal(MINIMAL_SYSTEM.length, 46)
assert.equal(hasDurableToolCall([{ type: 'assistant/message' }]), false)
assert.equal(hasDurableToolCall([{ type: 'tool/result' }]), false)
assert.equal(hasDurableToolCall([{ type: 'tool/call' }]), true)
const first = filterFirstRequest(assembled, [])
assert.deepEqual(first.tools.map(tool => tool.name), ['read', 'pwsh'])
assert.deepEqual(first.tools, tools.slice(0, 2), 'shared tool schemas changed')
assert.deepEqual(filterFirstRequest(assembled, [{ type: 'tool/result' }]).tools.map(tool => tool.name), ['read', 'pwsh'])
assert.equal(filterFirstRequest(assembled, [{ type: 'tool/call' }]), assembled)
assert.deepEqual(first.tools.map(tool => tool.name), ['read', 'pwsh'], 'an assembled request mutated after promotion')

const temporary = await mkdtemp(join(tmpdir(), 'dsv4-pro-anchored-96-'))
try {
  const record = await install({ sourceRoot, dshHome: temporary })
  assert.equal(record.presetId, PRESET_ID)
  assert.equal(RELEASE_VERSION, 'v0.2')
  const composition = await readFile(join(record.target, 'agent.cordis.yml'), 'utf8')
  const metadata = await readFile(join(record.target, 'preset.yml'), 'utf8')
  const standard = await readFile(standardPath, 'utf8')
  assert(composition.includes(`text: ${MINIMAL_SYSTEM}`))
  assert(composition.includes('complete: true'))
  assert(composition.includes('includeRuntimeContext: false'))
  assert.equal((composition.match(/id: dsv4-pro-anchored-96-tools/g) ?? []).length, 1)
  assert.equal((composition.match(/probe-stop|progressive-guard|requestMaxTokens/g) ?? []).length, 0)
  assert(metadata.includes(`name: DeepSeek V4 Pro Anchored ${RELEASE_VERSION}`))
  for (const id of ['tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill', 'tool-goal', 'tool-web']) {
    assert(composition.includes(`id: ${id}`), `missing Standard row ${id}`)
    assert(standard.includes(`id: ${id}`), `Standard source missing ${id}`)
  }
  assert.equal(await readFile(join(record.target, 'anchored-tools.mjs'), 'utf8'), await readFile(new URL('./anchored-tools.mjs', import.meta.url), 'utf8'))
} finally {
  await rm(temporary, { recursive: true, force: true })
}

console.log('dsv4-pro-anchored-96 tests passed')
