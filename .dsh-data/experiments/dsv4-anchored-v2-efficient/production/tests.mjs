#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  BOOTSTRAP_WRITE_BLOCKED,
  FIRST_STEP_BUDGET,
  INVENTORY_BLOCKED,
  REPEAT_BLOCKED,
  filterCatalog,
  guardDecision,
  hasQualifiedEvidence,
  isPlanMode,
} from './progressive-guard.mjs'

function call(callId, name, args, seq = 10) {
  return { type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args) } }
}

function result(callId, text = 'ok', seq = 11) {
  return { type: 'tool/result', seq, data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text }] }] } } }
}

function assistant(calls, step = 1) {
  return { type: 'assistant/message', data: { step, message: { content: calls.map((entry, index) => ({ type: 'tool-call', id: `c${index + 1}`, name: entry.name, arguments: entry.args })) } } }
}

function exec(name, args, events, callId = 'c1') {
  return { name, arguments: args, callId, agent: { session: { events } } }
}

const initial = []
const catalog = { tools: ['read', 'pwsh', 'edit', 'write', 'grep', 'glob', 'web_search', 'todo_write'].map(name => ({ name, description: name, parameters: { type: 'object' } })) }
assert.deepEqual(filterCatalog(catalog, []).tools.map(tool => tool.name), ['read', 'pwsh'])
const planEvents = [{ type: 'plan/mode', data: { active: true } }]
assert.equal(isPlanMode(planEvents), true)
assert.equal(filterCatalog(catalog, planEvents), catalog)
assert.equal(guardDecision(exec('glob', { pattern: '**/*' }, planEvents)), undefined)
assert.equal(isPlanMode([...planEvents, { type: 'plan/mode', data: { active: false } }]), false)
const read = call('read-1', 'read', { file_path: 'ONBOARDING_TODO.md' })
assert.equal(hasQualifiedEvidence([read, result('read-1')]), true)
assert.deepEqual(filterCatalog(catalog, [read, result('read-1')]).tools.map(tool => tool.name), ['read', 'pwsh', 'edit', 'write', 'grep', 'glob'])
assert.equal(filterCatalog(catalog, [read, result('read-1')]).tools[0], catalog.tools[0])
assert.equal(hasQualifiedEvidence([call('list', 'pwsh', { command: 'Get-ChildItem -Force' }), result('list')]), false)

const rootList = [assistant([{ name: 'pwsh', args: { command: 'Get-ChildItem -Force | Select-Object Name' } }])]
assert.equal(guardDecision(exec('pwsh', { command: 'Get-ChildItem -Force | Select-Object Name' }, rootList)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, initial)), undefined)
assert.equal(guardDecision(exec('pwsh', { command: "Set-Content -Path x.txt -Value 'x'" }, initial)), BOOTSTRAP_WRITE_BLOCKED)

const promoted = [read, result('read-1')]
assert.equal(guardDecision(exec('glob', { pattern: '**/*' }, promoted)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('glob', { pattern: 'project2_task/**/*.py' }, promoted)), undefined)
assert.equal(guardDecision(exec('grep', { pattern: 'TODO' }, promoted)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('grep', { pattern: 'TODO', path: 'project2_task' }, promoted)), undefined)

const three = [assistant([
  { name: 'read', args: { file_path: 'a' } },
  { name: 'read', args: { file_path: 'b' } },
  { name: 'read', args: { file_path: 'c' } },
])]
assert.equal(guardDecision(exec('read', { file_path: 'c' }, [...promoted, ...three], 'c3')), FIRST_STEP_BUDGET)

const command = 'python tests\\run_public_tests.py project2_task'
const repeated = [
  ...promoted,
  call('s1', 'pwsh', { command }, 20), result('s1', 'ok', 21),
  call('s2', 'pwsh', { command }, 22), result('s2', 'ok', 23),
]
assert.equal(guardDecision(exec('pwsh', { command }, repeated)), REPEAT_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command }, [...repeated, call('edit-1', 'edit', { file_path: 'x' }, 24)])), undefined)

console.log('production progressive guard tests passed')
