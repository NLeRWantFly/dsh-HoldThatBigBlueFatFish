#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  BOOTSTRAP_BUDGET_DENIAL,
  BOOTSTRAP_SCOPE_DENIAL,
  REPEAT_DENIAL,
  filterCatalog,
  guardDecision,
  hasQualifiedEvidence,
} from './plugins/v2-policy.mjs'
import {
  BOOTSTRAP_BUDGET_DENIAL as V3_BUDGET_DENIAL,
  BOOTSTRAP_SCOPE_DENIAL as V3_SCOPE_DENIAL,
  guardDecision as v3GuardDecision,
} from './plugins/v3-policy.mjs'
import {
  BOOTSTRAP_BUDGET_DENIAL as V4_BUDGET_DENIAL,
  BOOTSTRAP_SCOPE_DENIAL as V4_SCOPE_DENIAL,
  INVENTORY_DENIAL as V4_INVENTORY_DENIAL,
  filterCatalog as v4FilterCatalog,
  guardDecision as v4GuardDecision,
  hasQualifiedEvidence as v4HasQualifiedEvidence,
} from './plugins/v4-policy.mjs'
import {
  BUDGET_DENIAL as V6_BUDGET_DENIAL,
  INVENTORY_DENIAL as V6_INVENTORY_DENIAL,
  guardDecision as v6GuardDecision,
} from './plugins/v6-prefetch-policy.mjs'

function toolCall(callId, name, args, seq = 10) {
  return { type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args), step: 1, turn: 1 } }
}

function toolResult(callId, { error = false, text = 'ok' } = {}, seq = 11) {
  return { type: 'tool/result', seq, data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: error, content: [{ type: 'text', text }] }] } } }
}

function assistant(calls, step = 1) {
  return { type: 'assistant/message', data: { turn: 1, step, message: { content: calls.map((call, index) => ({ type: 'tool-call', id: `c${index + 1}`, name: call.name, arguments: call.args })) } } }
}

function execFor(name, args, events, callId = 'c1') {
  return { name, arguments: args, callId, agent: { session: { events } } }
}

const catalog = { tools: ['read', 'pwsh', 'edit', 'write', 'grep', 'glob', 'web_search', 'todo_write'].map(name => ({ name, schema: { name } })) }
assert.deepEqual(filterCatalog(catalog, []).tools.map(tool => tool.name), ['read', 'pwsh'])

const rootList = toolCall('root', 'pwsh', { command: 'Get-ChildItem -Force' })
assert.equal(hasQualifiedEvidence([rootList, toolResult('root')]), false)
const readCall = toolCall('read1', 'read', { file_path: 'ONBOARDING_TODO.md' })
assert.equal(hasQualifiedEvidence([readCall, toolResult('read1')]), true)
assert.equal(hasQualifiedEvidence([readCall, toolResult('read1', { error: true })]), false)
assert.equal(hasQualifiedEvidence([readCall, toolResult('read1', { text: BOOTSTRAP_SCOPE_DENIAL })]), false)

const promoted = filterCatalog(catalog, [readCall, toolResult('read1')])
assert.deepEqual(promoted.tools.map(tool => tool.name), ['read', 'pwsh', 'edit', 'write', 'grep', 'glob'])
assert.equal(promoted.tools.find(tool => tool.name === 'edit'), catalog.tools.find(tool => tool.name === 'edit'))

const broadAssistant = [assistant([{ name: 'pwsh', args: { command: 'Get-ChildItem -Recurse -Depth 2' } }])]
assert.equal(guardDecision(execFor('pwsh', { command: 'Get-ChildItem -Recurse -Depth 2' }, broadAssistant)), BOOTSTRAP_SCOPE_DENIAL)
assert.equal(guardDecision(execFor('pwsh', { command: 'rg --files' }, broadAssistant)), BOOTSTRAP_SCOPE_DENIAL)
assert.equal(guardDecision(execFor('pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, broadAssistant)), undefined)
assert.equal(guardDecision(execFor('pwsh', { command: 'npm test', run_in_background: true }, broadAssistant)), BOOTSTRAP_SCOPE_DENIAL)

const threeCalls = [assistant([
  { name: 'read', args: { file_path: 'a' } },
  { name: 'read', args: { file_path: 'b' } },
  { name: 'read', args: { file_path: 'c' } },
])]
assert.equal(guardDecision(execFor('read', { file_path: 'c' }, threeCalls, 'c3')), BOOTSTRAP_BUDGET_DENIAL)

const evidence = [readCall, toolResult('read1')]
const repeated = [
  ...evidence,
  toolCall('t1', 'pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, 20),
  toolResult('t1', {}, 21),
  toolCall('t2', 'pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, 22),
  toolResult('t2', {}, 23),
  assistant([{ name: 'pwsh', args: { command: 'python tests\\run_public_tests.py project2_task' } }], 4),
]
assert.equal(guardDecision(execFor('pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, repeated)), REPEAT_DENIAL)
const reset = [...repeated.slice(0, -1), toolCall('e1', 'edit', { file_path: 'x' }, 24), repeated.at(-1)]
assert.equal(guardDecision(execFor('pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, reset)), undefined)

const twoCalls = [assistant([
  { name: 'read', args: { file_path: 'ONBOARDING_TODO.md' } },
  { name: 'pwsh', args: { command: 'Get-ChildItem -Force' } },
])]
assert.equal(v3GuardDecision(execFor('pwsh', { command: 'Get-ChildItem -Force' }, twoCalls, 'c2')), V3_BUDGET_DENIAL)
assert.equal(v3GuardDecision(execFor('pwsh', { command: 'Get-ChildItem -Recurse project2_task' }, evidence)), V3_SCOPE_DENIAL)
assert.equal(v3GuardDecision(execFor('pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, evidence)), undefined)

const namedUser = { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'First read ONBOARDING_TODO.md.' }] } }
const v4Read = toolCall('v4-read', 'read', { file_path: 'ONBOARDING_TODO.md' }, 2)
const v4Result = toolResult('v4-read', {}, 3)
assert.deepEqual(v4FilterCatalog(catalog, [namedUser]).tools.map(tool => tool.name), ['read'])
assert.equal(v4HasQualifiedEvidence([namedUser, v4Read, v4Result]), true)
assert.deepEqual(v4FilterCatalog(catalog, [namedUser, v4Read, v4Result]).tools.map(tool => tool.name), ['read', 'pwsh', 'edit', 'write', 'grep', 'glob'])
assert.equal(v4GuardDecision(execFor('read', { file_path: 'ONBOARDING_TODO.md' }, [namedUser, assistant([{ name: 'read', args: { file_path: 'ONBOARDING_TODO.md' } }])])), undefined)
assert.equal(v4GuardDecision(execFor('read', { file_path: 'secret.txt' }, [namedUser, assistant([{ name: 'read', args: { file_path: 'secret.txt' } }])])), V4_SCOPE_DENIAL)
const v4TwoReads = [namedUser, assistant([{ name: 'read', args: { file_path: 'ONBOARDING_TODO.md' } }, { name: 'read', args: { file_path: 'ONBOARDING_TODO.md' } }])]
assert.equal(v4GuardDecision(execFor('read', { file_path: 'ONBOARDING_TODO.md' }, v4TwoReads, 'c2')), V4_BUDGET_DENIAL)
const v4PromotionRace = [namedUser, ...v4TwoReads.slice(1), v4Read, v4Result]
assert.equal(v4GuardDecision(execFor('read', { file_path: 'ONBOARDING_TODO.md' }, v4PromotionRace, 'c2')), V4_BUDGET_DENIAL)
assert.equal(v4GuardDecision(execFor('pwsh', { command: 'Get-ChildItem -Recurse project2_task' }, [namedUser, v4Read, v4Result])), V4_INVENTORY_DENIAL)

const v6ThreeCalls = [assistant([
  { name: 'read', args: { file_path: 'a' } },
  { name: 'pwsh', args: { command: 'python tests\\run_public_tests.py project2_task' } },
  { name: 'read', args: { file_path: 'b' } },
])]
assert.equal(v6GuardDecision(execFor('read', { file_path: 'b' }, v6ThreeCalls, 'c3')), V6_BUDGET_DENIAL)
assert.equal(v6GuardDecision(execFor('pwsh', { command: 'Get-ChildItem -Recurse project2_task' }, [])), V6_INVENTORY_DENIAL)

console.log('v2-v6 efficient policy tests passed')
