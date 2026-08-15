#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { MINIMAL_SYSTEM, PRESET_IDS, ROUTE } from './constants.mjs'
import { assertNoSuspectedSecret, scoreTrajectory } from './lib.mjs'
import { filterFirstRequest, hasDurableToolCall } from './plugins/anchored-tools.mjs'
import { filterEveryRequest } from './plugins/fixed-tools.mjs'
import { reportMarkdown } from './report.mjs'

const tools = [
  { name: 'read', description: 'read', inputSchema: { type: 'object' } },
  { name: 'pwsh', description: 'shell', inputSchema: { type: 'object' } },
  { name: 'glob', description: 'glob', inputSchema: { type: 'object' } },
  { name: 'todo_write', description: 'todo', inputSchema: { type: 'object' } },
]
const assembled = Object.freeze({ sections: [], contexts: [], tools, variables: {} })

assert.equal(MINIMAL_SYSTEM.length, 46)
assert.equal(hasDurableToolCall([{ type: 'tool/result' }]), false)
assert.equal(hasDurableToolCall([{ type: 'assistant/message', data: { text: 'use a tool' } }]), false)
assert.equal(hasDurableToolCall([{ type: 'tool/call' }]), true)

const first = filterFirstRequest(assembled, [])
assert.deepEqual(first.tools.map(tool => tool.name), ['read', 'pwsh'])
assert.deepEqual(filterFirstRequest(assembled, [{ type: 'tool/result' }]).tools.map(tool => tool.name), ['read', 'pwsh'])
assert.equal(filterFirstRequest(assembled, [{ type: 'tool/call' }]), assembled)
assert.deepEqual(first.tools.map(tool => tool.name), ['read', 'pwsh'], 'an already assembled response must not mutate after promotion')
assert.deepEqual(filterEveryRequest(assembled).tools.map(tool => tool.name), ['read', 'pwsh'])
const linuxAssembled = { ...assembled, tools: [tools[0], { ...tools[1], name: 'bash' }, ...tools.slice(2)] }
assert.deepEqual(filterFirstRequest(linuxAssembled, []).tools.map(tool => tool.name), ['read', 'bash'])
assert.deepEqual(filterEveryRequest(linuxAssembled).tools.map(tool => tool.name), ['read', 'bash'])
assert.throws(() => filterFirstRequest({ ...assembled, tools: tools.filter(tool => tool.name !== 'read') }, []), /every common tool/)
assert.throws(() => filterFirstRequest({ ...assembled, tools: [...tools, { name: 'bash' }] }, []), /one native shell/)
assert.throws(() => assertNoSuspectedSecret(`token=${['s', 'k-', 'abcdefghijklmnopqrstuvwxyz123456'].join('')}`), /SECRET_DETECTED/)

const syntheticTools = tools.slice(0, 3)
const syntheticEvents = [
  { type: 'request/header', seq: 1, time: 1000, data: { header: { config: ROUTE, system: MINIMAL_SYSTEM, tools: syntheticTools.slice(0, 2) }, reason: 'initial' } },
  { type: 'step/start', seq: 2, time: 1010, data: { turn: 1, step: 1 } },
  { type: 'assistant/chunk', seq: 3, time: 1020, data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 4, time: 1100, data: { turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20, reasoningTokens: 10 }, message: { content: [
    { type: 'reasoning', text: 'read the named handoff' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: { path: 'ONBOARDING_TODO.md' } },
  ] } } },
  { type: 'tool/call', seq: 5, time: 1110, data: { callId: 'c1', toolName: 'read' } },
  { type: 'tool/result', seq: 6, time: 1120, data: { callId: 'c1' } },
  { type: 'request/header', seq: 7, time: 1130, data: { header: { config: ROUTE, system: MINIMAL_SYSTEM, tools: syntheticTools }, reason: 'change' } },
  { type: 'assistant/message', seq: 8, time: 1200, data: { turn: 1, step: 2, usage: { inputTokens: 120, outputTokens: 10 }, message: { content: [
    { type: 'tool-call', id: 'c2', name: 'glob', arguments: { path: 'project2_task/src', pattern: '*.py' } },
  ] } } },
  { type: 'turn/end', seq: 9, time: 1210, data: { turn: 1, reason: { kind: 'completed' } } },
]
const syntheticSample = {
  id: 'synthetic-minimal-anchored', suite: 'probe', platform: 'windows-native', condition: 'minimal-anchored', repeat: 1,
  prompt: 'repair Project2', sessionId: 'probe-dsv4-official-synthetic', eventFile: 'events/synthetic.jsonl', sentAt: 1000,
}
const syntheticScore = scoreTrajectory(syntheticSample, syntheticEvents)
assert.equal(syntheticScore.minimalSystemExact, true)
assert.equal(syntheticScore.promotion.promotedOnFollowingRequest, true)
assert.deepEqual(syntheticScore.promotion.outsideBootstrapToolsUsed, ['glob'])
assert.equal(syntheticScore.firstCompliant, true)
assert(reportMarkdown({
  manifest: { generatedAt: '2026-08-15T00:00:00Z', platform: 'windows-native', hostBaseUrl: 'local', officialBaseUrl: 'https://api.deepseek.com', hashes: {}, samples: [], dsh: {}, versions: {}, project2: {} },
  scores: [syntheticScore], projectResults: [],
}).includes('synthetic-minimal-anchored'))

const presetRoot = resolve('.dsh-data/.agent-presets')
for (const [condition, presetId] of Object.entries(PRESET_IDS)) {
  const text = await readFile(join(presetRoot, presetId, 'agent.cordis.yml'), 'utf8')
  assert.equal((text.match(/id: dsv4-official-probe-stop/g) ?? []).length, 1, `${condition}: probe hook count`)
  if (condition.startsWith('minimal-')) {
    assert(text.includes(`text: ${MINIMAL_SYSTEM}`), `${condition}: minimal persona`)
    assert(text.includes('complete: true'), `${condition}: complete persona`)
    assert(text.includes('includeRuntimeContext: false'), `${condition}: runtime suppression`)
  } else {
    assert(!text.includes(`text: ${MINIMAL_SYSTEM}`), `${condition}: Standard persona preserved`)
  }
  const anchoredCount = (text.match(/id: dsv4-official-anchored-tools/g) ?? []).length
  assert.equal(anchoredCount, condition.endsWith('-anchored') ? 1 : 0, `${condition}: anchored hook count`)
  const fixedCount = (text.match(/id: dsv4-official-fixed-tools/g) ?? []).length
  assert.equal(fixedCount, condition === 'minimal-fixed' ? 1 : 0, `${condition}: fixed hook count`)
}

console.log('anchored/fixed state and generated preset tests passed')
