#!/usr/bin/env node
import assert from 'node:assert/strict'
import { FLASH_PERSONA, PRO_PERSONA } from './model-policy.mjs'
import {
  BOOTSTRAP_WRITE_BLOCKED,
  ENVIRONMENT_BLOCKED,
  ENVIRONMENT_PROBE_BLOCKED,
  ENVIRONMENT_WORKAROUND_BLOCKED,
  FINAL_REQUIRED,
  FIRST_STEP_BUDGET,
  INTERNAL_CONTEXT_BLOCKED,
  INVENTORY_BLOCKED,
  MUTATION_TOO_LARGE,
  PROGRESS_REQUIRED,
  RECHECK_REQUIRED,
  REPEAT_BLOCKED,
  SHELL_CONTENT_WRITE_BLOCKED,
  SLICE_BUDGET,
  STOP_AFTER_CHECK,
  apply,
  boundedShallowProbe,
  configuredModelId,
  filterCatalog,
  guardDecision,
  hasQualifiedEvidence,
  isPlanMode,
  modelFromEvents,
  progressiveDisclosureForModel,
  shapeAssembly,
  shapeRequest,
  successfulResult,
  workflowStage,
} from './progressive-guard.mjs'

function call(callId, name, args, seq = 10) {
  return { type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args) } }
}

function result(callId, text = 'ok', seq = 11, isError = false) {
  return { type: 'tool/result', seq, data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }] } } }
}

function requestHeader(model, seq = 0) {
  return { type: 'request/header', seq, data: { header: { config: { provider: 'deepseek-official', model } } } }
}

function assistant(calls, step = 1, seq = 1) {
  return {
    type: 'assistant/message',
    seq,
    data: {
      step,
      message: {
        content: calls.map((entry, index) => ({
          type: 'tool-call',
          id: entry.id ?? `c${index + 1}`,
          name: entry.name,
          arguments: entry.args,
        })),
      },
    },
  }
}

function exec(name, args, events, callId = 'c1') {
  return { name, arguments: args, callId, agent: { session: { events } } }
}

const parameter = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const catalog = {
  tools: [
    { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { file_path: parameter('path', true) }, required: ['file_path'] } },
    {
      name: 'pwsh',
      description: `PowerShell full schema ${'verbose '.repeat(100)}`,
      parameters: {
        type: 'object',
        properties: {
          command: parameter('command', true),
          description: parameter('description', true),
          timeoutMs: { type: 'number' },
          workdir: parameter('workdir'),
          run_in_background: { type: 'boolean' },
          sandbox_permissions: parameter('sandbox'),
          justification: parameter('why'),
        },
        required: ['command', 'description'],
      },
    },
    {
      name: 'edit',
      description: 'Edit file',
      parameters: {
        type: 'object',
        properties: {
          file_path: parameter('path', true),
          old_string: parameter('old', true),
          new_string: parameter('new', true),
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'write',
      description: 'Write file',
      parameters: {
        type: 'object',
        properties: { file_path: parameter('path', true), content: parameter('content', true) },
        required: ['file_path', 'content'],
      },
    },
    { name: 'grep', description: 'Search file', parameters: { type: 'object', properties: { pattern: parameter('pattern'), path: parameter('path') } } },
    { name: 'glob', description: 'Match files', parameters: { type: 'object', properties: { pattern: parameter('pattern') } } },
    { name: 'web_search', description: 'web', parameters: { type: 'object', properties: {} } },
    { name: 'todo_write', description: 'todo', parameters: { type: 'object', properties: {} } },
  ],
}

// Bootstrap schema is small, deterministic, foreground-only, and does not advertise DSH internals.
const initialA = filterCatalog(catalog, [])
const initialB = filterCatalog(catalog, [])
assert.deepEqual(initialA.tools.map(tool => tool.name), ['read', 'pwsh'])
assert.equal(JSON.stringify(initialA), JSON.stringify(initialB))
assert.notEqual(initialA.tools[1], catalog.tools[1])
assert.equal(initialA.tools[1].parameters.properties.run_in_background, undefined)
assert.equal(initialA.tools[1].parameters.properties.sandbox_permissions, undefined)
assert.equal(initialA.tools[1].parameters.additionalProperties, false)
assert.doesNotMatch(initialA.tools[1].description, /environment facts|DSH_\*/i)
assert.match(initialA.tools[1].description, /at most 50 immediate entries/i)
assert(JSON.stringify(initialA.tools[1]).length < JSON.stringify(catalog.tools[1]).length)
assert(catalog.tools[1].parameters.properties.run_in_background)

const planEvents = [{ type: 'plan/mode', data: { active: true } }]
assert.equal(isPlanMode(planEvents), true)
assert.equal(filterCatalog(catalog, planEvents), catalog)
assert.equal(guardDecision(exec('glob', { pattern: '**/*' }, planEvents)), undefined)
assert.equal(isPlanMode([...planEvents, { type: 'plan/mode', data: { active: false } }]), false)

const assembly = {
  ...catalog,
  sections: [
    { name: 'persona', text: 'fallback', order: 0 },
    { name: 'plan-mode', text: 'native plan boundary', order: 10 },
  ],
  contexts: [],
  variables: {},
}
const proAssembly = shapeAssembly(assembly, [], 'deepseek-v4-pro')
assert.equal(proAssembly.sections[0].text, PRO_PERSONA)
assert.deepEqual(proAssembly.tools.map(tool => tool.name), ['read', 'pwsh', 'edit', 'write', 'grep', 'glob'])
const flashAssembly = shapeAssembly(assembly, [], 'deepseek-v4-flash')
assert.equal(flashAssembly.sections[0].text, FLASH_PERSONA)
assert.deepEqual(flashAssembly.tools.map(tool => tool.name), ['read', 'pwsh'])
assert.equal(progressiveDisclosureForModel('deepseek-v4-pro'), false)
assert.equal(progressiveDisclosureForModel('deepseek-v4-flash'), true)
assert.equal(progressiveDisclosureForModel(undefined), true)
assert.equal(configuredModelId({ modelPolicy: 'pro' }, undefined), 'deepseek-v4-pro')
assert.equal(configuredModelId({ modelPolicy: 'flash' }, 'deepseek-v4-pro'), 'deepseek-v4-flash')
assert.deepEqual(filterCatalog(catalog, [], { modelPolicy: 'pro' }).tools.map(tool => tool.name), ['read', 'pwsh', 'edit', 'write', 'grep', 'glob'])
assert.deepEqual(filterCatalog(catalog, [], { modelPolicy: 'flash' }).tools.map(tool => tool.name), ['read', 'pwsh'])
assert.equal(modelFromEvents([requestHeader('deepseek-v4-pro')]), 'deepseek-v4-pro')
assert.equal(modelFromEvents([requestHeader('deepseek-v4-pro'), requestHeader('deepseek-v4-flash', 2)]), 'deepseek-v4-flash')
const proAfterEvidence = shapeAssembly(assembly, [
  call('pro-read', 'read', { file_path: 'README.md' }),
  result('pro-read', '<content>ok</content>'),
], 'deepseek-v4-pro')
assert.equal(JSON.stringify(proAfterEvidence.tools), JSON.stringify(proAssembly.tools))
const proWrite = exec('write', { file_path: 'app.js', content: 'small' }, [])
proWrite.agent.options = { model: 'deepseek-v4-pro' }
assert.equal(guardDecision(proWrite), undefined)
const proOversizedWrite = exec('write', { file_path: 'app.js', content: 'x'.repeat(12_001) }, [])
proOversizedWrite.agent.options = { model: 'deepseek-v4-pro' }
assert.equal(guardDecision(proOversizedWrite), MUTATION_TOO_LARGE)
const persistedProWrite = exec('write', { file_path: 'app.js', content: 'small' }, [requestHeader('deepseek-v4-pro')])
assert.equal(guardDecision(persistedProWrite), undefined)
assert.equal(guardDecision(exec('write', { file_path: 'app.js', content: 'small' }, []), { modelPolicy: 'pro' }), undefined)
const planAssembly = shapeAssembly(assembly, planEvents, 'deepseek-v4-flash')
assert.equal(planAssembly.sections[0].text, FLASH_PERSONA)
assert.equal(planAssembly.sections.some(section => section.name === 'plan-mode'), true)
assert.equal(planAssembly.tools.length, catalog.tools.length)

// Promotion requires valid project evidence, not merely a matching command spelling.
const read = call('read-1', 'read', { file_path: 'ONBOARDING_TODO.md' })
assert.equal(hasQualifiedEvidence([read, result('read-1', '<content>todo</content>')]), true)
assert.equal(hasQualifiedEvidence([read, result('read-1', 'Access denied', 11, true)]), false)
assert.equal(hasQualifiedEvidence([
  call('compressed', 'read', { file_path: 'session.jsonl.zstd' }),
  result('compressed', '\u0000\ufffd\ufffdgarbage'),
]), false)
assert.equal(hasQualifiedEvidence([
  call('dsh', 'pwsh', { command: 'Get-Content $env:DSH_SESSION_JSONL' }),
  result('dsh', '[exit code: 0]\n\ufffd\ufffdgarbage'),
]), false)

const boundedPwsh = 'Get-ChildItem -Force | Select-Object -First 50 Name,Mode,Length'
assert.equal(boundedShallowProbe('pwsh', boundedPwsh), true)
assert.equal(guardDecision(exec('pwsh', { command: boundedPwsh }, [])), undefined)
const probe = call('probe', 'pwsh', { command: boundedPwsh })
assert.equal(hasQualifiedEvidence([probe, result('probe', '[exit code: 0]')]), true)
assert.equal(hasQualifiedEvidence([probe, result('probe', '[exit code: 1]')]), false)
assert.equal(hasQualifiedEvidence([probe, result('probe', 'ERROR: permission denied')]), false)
assert.equal(hasQualifiedEvidence([probe, result('probe', 'ReferenceError: broken')]), false)
assert.equal(hasQualifiedEvidence([probe, result('probe', 'Get-ChildItem : Access is denied\nCategoryInfo : PermissionDenied')]), false)
assert.equal(successfulResult(result('ok', '10 passed, 0 failed\n[exit code: 0]')), true)
assert.equal(successfulResult(result('bad', 'FAILED tests/test_a.py\n[exit code: 1]')), false)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-ChildItem -Force' }, [])), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-ChildItem -Force | Select-Object -First 51 Name' }, [])), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-ChildItem -Path . -Force | Select-Object -First 51 Name' }, [])), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-ChildItem -LiteralPath src -Force | Select-Object -First 50 Name' }, [])), undefined)
assert.equal(boundedShallowProbe('pwsh', `${boundedPwsh}\nGet-ChildItem -Recurse`), false)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-ChildItem Env:DSH_*' }, [])), INTERNAL_CONTEXT_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-Content $env:DSH_SESSION_JSONL' }, [])), INTERNAL_CONTEXT_BLOCKED)

const boundedBash = 'find . -maxdepth 1 -mindepth 1 -print | head -n 50'
assert.equal(boundedShallowProbe('bash', boundedBash), true)
assert.equal(boundedShallowProbe('bash', 'ls -la | head -n 50'), true)
assert.equal(boundedShallowProbe('bash', 'find . -maxdepth 2 -print | head -n 50'), false)
const bashCatalog = { ...catalog, tools: catalog.tools.map(tool => tool.name === 'pwsh' ? { ...tool, name: 'bash' } : tool) }
assert.deepEqual(filterCatalog(bashCatalog, []).tools.map(tool => tool.name), ['read', 'bash'])
assert.equal(guardDecision(exec('bash', { command: boundedBash }, [])), undefined)
assert.equal(guardDecision(exec('bash', { command: 'find . -type f' }, [])), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('bash', { command: 'ls reference' }, [])), undefined)
assert.equal(guardDecision(exec('bash', { command: 'ls tests/public' }, [])), undefined)
assert.equal(guardDecision(exec('bash', { command: 'ls -la' }, [])), INVENTORY_BLOCKED)

// The promoted catalog is stable and gives mutation schemas a model-visible bound.
const promoted = [read, result('read-1', '<content>todo</content>')]
const coreA = filterCatalog(catalog, promoted)
const coreB = filterCatalog(catalog, promoted)
assert.deepEqual(coreA.tools.map(tool => tool.name), ['read', 'pwsh', 'edit', 'write', 'grep', 'glob'])
assert.equal(JSON.stringify(coreA), JSON.stringify(coreB))
assert.equal(coreA.tools[0], catalog.tools[0])
assert.equal(coreA.tools.find(tool => tool.name === 'pwsh'), catalog.tools[1])
assert.equal(coreA.tools.find(tool => tool.name === 'write').parameters.properties.content.maxLength, 12_000)
assert.equal(coreA.tools.find(tool => tool.name === 'edit').parameters.properties.old_string.maxLength, 12_000)
assert.equal(coreA.tools.find(tool => tool.name === 'edit').parameters.properties.new_string.maxLength, 12_000)
assert.equal(catalog.tools.find(tool => tool.name === 'write').parameters.properties.content.maxLength, undefined)

// First-step, inventory, background, and bootstrap mutation containment.
const three = [assistant([
  { name: 'read', args: { file_path: 'a' } },
  { name: 'read', args: { file_path: 'b' } },
  { name: 'read', args: { file_path: 'c' } },
])]
assert.equal(guardDecision(exec('read', { file_path: 'c' }, [...promoted, ...three], 'c3')), FIRST_STEP_BUDGET)
assert.equal(guardDecision(exec('pwsh', { command: 'npm test', run_in_background: true }, promoted)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command: 'python tests\\run_public_tests.py project2_task' }, [])), undefined)
assert.equal(guardDecision(exec('pwsh', { command: "Set-Content -Path x.txt -Value 'x'" }, [])), BOOTSTRAP_WRITE_BLOCKED)
assert.equal(guardDecision(exec('glob', { pattern: '**/*' }, promoted)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('glob', { pattern: '**/*.md' }, promoted)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('glob', { pattern: 'project2_task/**/*' }, promoted)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('glob', { pattern: 'project2_task/esp32/testpro4/**/*' }, promoted)), undefined)
assert.equal(guardDecision(exec('glob', { pattern: 'tests/public/**/*' }, promoted)), undefined)
assert.equal(guardDecision(exec('glob', { pattern: 'project2_task/**/*.py' }, promoted)), undefined)
assert.equal(guardDecision(exec('grep', { pattern: 'TODO' }, promoted)), INVENTORY_BLOCKED)
assert.equal(guardDecision(exec('grep', { pattern: 'TODO', path: 'project2_task' }, promoted)), undefined)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-Content $env:DSH_SESSION_JSONL' }, promoted)), INTERNAL_CONTEXT_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command: "Set-Content app.js 'large payload'" }, promoted)), SHELL_CONTENT_WRITE_BLOCKED)

// Vertical-slice limits are enforced on complete tool arguments and across a step/check cycle.
const oversized = [
  ...promoted,
  assistant([{ name: 'write', args: { file_path: 'app.js', content: 'x'.repeat(12_001) } }], 2, 20),
]
assert.equal(guardDecision(exec('write', { file_path: 'app.js', content: 'x'.repeat(12_001) }, oversized)), MUTATION_TOO_LARGE)

const threeWrites = [
  ...promoted,
  assistant([
    { name: 'write', args: { file_path: 'a.js', content: 'a' } },
    { name: 'write', args: { file_path: 'b.js', content: 'b' } },
    { name: 'write', args: { file_path: 'c.js', content: 'c' } },
  ], 2, 20),
]
assert.equal(guardDecision(exec('write', { file_path: 'c.js', content: 'c' }, threeWrites, 'c3')), SLICE_BUDGET)

const unverified = [
  ...promoted,
  call('w1', 'write', { file_path: 'a.js', content: 'a'.repeat(8_000) }, 20),
  result('w1', 'Created file', 21),
  assistant([{ name: 'write', args: { file_path: 'b.js', content: 'b'.repeat(3_000) } }], 3, 22),
]
assert.equal(guardDecision(
  exec('write', { file_path: 'b.js', content: 'b'.repeat(3_000) }, unverified),
  { maxUnverifiedMutationChars: 10_000 },
), SLICE_BUDGET)

const checked = [
  ...unverified.slice(0, -1),
  call('check-1', 'pwsh', { command: 'node --check a.js' }, 22),
  result('check-1', '[exit code: 0]', 23),
  assistant([{ name: 'write', args: { file_path: 'b.js', content: 'b'.repeat(3_000) } }], 4, 24),
]
assert.equal(guardDecision(
  exec('write', { file_path: 'b.js', content: 'b'.repeat(3_000) }, checked),
  { maxUnverifiedMutationChars: 10_000 },
), undefined)

// A completed failing check is evidence too: it opens a fresh repair slice.
const checkedFailure = [
  ...unverified.slice(0, -1),
  call('check-failed', 'pwsh', { command: 'node --check a.js' }, 22),
  result('check-failed', 'SyntaxError: expected token\n[exit code: 1]', 23),
  assistant([{ name: 'write', args: { file_path: 'b.js', content: 'b'.repeat(3_000) } }], 4, 24),
]
assert.equal(guardDecision(
  exec('write', { file_path: 'b.js', content: 'b'.repeat(3_000) }, checkedFailure),
  { maxUnverifiedMutationChars: 10_000 },
), undefined)

// A passed final check gets a total audit budget across different tools and commands.
const afterPass = [
  ...promoted,
  call('w2', 'write', { file_path: 'app.js', content: 'ok' }, 20), result('w2', 'Created file', 21),
  call('check-2', 'pwsh', { command: 'node --check app.js' }, 22), result('check-2', '[exit code: 0]', 23),
  assistant([
    { name: 'read', args: { file_path: 'app.js' } },
    { name: 'grep', args: { pattern: 'ok', path: 'app.js' } },
    { name: 'pwsh', args: { command: 'Get-Location' } },
  ], 5, 24),
]
assert.equal(guardDecision(exec('read', { file_path: 'app.js' }, afterPass, 'c1')), undefined)
assert.equal(guardDecision(exec('grep', { pattern: 'ok', path: 'app.js' }, afterPass, 'c2')), undefined)
assert.equal(guardDecision(exec('pwsh', { command: 'Get-Location' }, afterPass, 'c3')), STOP_AFTER_CHECK)

const reopenedByFailure = [
  ...afterPass.slice(0, -1),
  call('check-3', 'pwsh', { command: 'npm test' }, 24), result('check-3', 'FAILED one test\n[exit code: 1]', 25),
  assistant([{ name: 'read', args: { file_path: 'app.js' } }], 6, 26),
]
assert.equal(guardDecision(exec('read', { file_path: 'app.js' }, reopenedByFailure)), undefined)

const reopenedByFix = [
  ...afterPass.slice(0, -1),
  call('edit-1', 'edit', { file_path: 'app.js', old_string: 'ok', new_string: 'fixed' }, 24),
  result('edit-1', 'updated successfully', 25),
  assistant([{ name: 'read', args: { file_path: 'app.js' } }], 6, 26),
]
assert.equal(guardDecision(exec('read', { file_path: 'app.js' }, reopenedByFix)), undefined)
assert.equal(guardDecision(
  exec('edit', { file_path: 'app.js', old_string: 'fixed', new_string: 'fixed-again' }, reopenedByFix),
), RECHECK_REQUIRED)

const postPassDiagnostics = [
  ...reopenedByFix.slice(0, -1),
  call('audit-1', 'read', { file_path: 'app.js' }, 26), result('audit-1', 'fixed', 27),
  call('audit-2', 'grep', { pattern: 'fixed', path: 'app.js' }, 28), result('audit-2', '1 match', 29),
]
assert.equal(guardDecision(exec('read', { file_path: 'other.js' }, postPassDiagnostics)), RECHECK_REQUIRED)

// Environment failures are not invitations to repair the harness or retry forever.
const command = 'python tests\\run_public_tests.py project2_task'
const environmentBlocked = [
  ...promoted,
  call('env-1', 'pwsh', { command }, 20), result('env-1', 'PermissionError: [WinError 5] Access is denied\n[exit code: 1]', 21),
  call('env-2', 'pwsh', { command }, 22), result('env-2', '[sandbox: write denied]\n[exit code: 1]', 23),
]
assert.equal(guardDecision(exec('pwsh', { command }, environmentBlocked)), ENVIRONMENT_BLOCKED)
const pythonRuntimeBlocked = [
  ...promoted,
  call('runtime-1', 'bash', { command: 'python tests/run_public_tests.py project2_task' }, 20), result('runtime-1', '(no output)\n[exit code: 1]', 21),
  call('runtime-2', 'bash', { command: 'python tools/run_debug_probe.py project2_task' }, 22), result('runtime-2', '(no output)\n[exit code: 1]', 23),
]
assert.equal(guardDecision(exec('bash', { command: 'python -m pytest tests/public' }, pythonRuntimeBlocked)), ENVIRONMENT_BLOCKED)
assert.equal(guardDecision(exec('bash', { command: 'python --version' }, promoted)), ENVIRONMENT_PROBE_BLOCKED)
assert.equal(guardDecision(exec('bash', { command: 'where python' }, promoted)), ENVIRONMENT_PROBE_BLOCKED)
assert.equal(guardDecision(exec('glob', { pattern: '**/python.exe' }, promoted)), ENVIRONMENT_PROBE_BLOCKED)
assert.equal(guardDecision(exec('glob', { pattern: '**/.venv/**' }, promoted)), ENVIRONMENT_PROBE_BLOCKED)
assert.equal(guardDecision(exec('write', { file_path: 'sitecustomize.py', content: 'patch tempfile' }, promoted)), ENVIRONMENT_WORKAROUND_BLOCKED)
assert.equal(guardDecision(exec('edit', { file_path: '.pytool/runtime/package.json', old_string: 'a', new_string: 'b' }, promoted)), ENVIRONMENT_WORKAROUND_BLOCKED)
assert.equal(guardDecision(exec('bash', { command: 'npm install @agent-webui/ai-desk-python-win32-x64 --prefix .pytool' }, promoted)), ENVIRONMENT_WORKAROUND_BLOCKED)

// Progress and total budgets are derived from persisted events and survive reloads.
const diagnosticsOnly = [
  call('d1', 'read', { file_path: 'a.js' }, 20), result('d1', 'a', 21),
  call('d2', 'grep', { pattern: 'x', path: 'a.js' }, 22), result('d2', 'x', 23),
]
const deniedOnly = [
  call('denied', 'glob', { pattern: '**/*' }, 18), result('denied', `Error: ${INVENTORY_BLOCKED}`, 19, true),
]
assert.equal(guardDecision(exec('read', { file_path: 'a.js' }, deniedOnly), { maxCallsWithoutProgress: 1 }), undefined)
assert.equal(guardDecision(exec('read', { file_path: 'b.js' }, diagnosticsOnly), { maxCallsWithoutProgress: 2 }), PROGRESS_REQUIRED)
assert.equal(guardDecision(exec('write', { file_path: 'b.js', content: 'small' }, diagnosticsOnly), { maxCallsWithoutProgress: 2 }), undefined)
assert.equal(guardDecision(exec('pwsh', { command: 'npm test' }, diagnosticsOnly), { maxCallsWithoutProgress: 2 }), undefined)
assert.equal(guardDecision(exec('read', { file_path: 'b.js' }, diagnosticsOnly), { maxTotalToolCalls: 2 }), FINAL_REQUIRED)

assert.equal(workflowStage([], { maxTotalToolCalls: 99 }), 'discovery')
assert.equal(workflowStage([
  call('stage-write', 'write', { file_path: 'app.js', content: 'x' }), result('stage-write', 'ok'),
], { maxTotalToolCalls: 99 }), 'implementation')
assert.equal(workflowStage(afterPass.slice(0, -1), { maxTotalToolCalls: 99 }), 'acceptance')
assert.equal(workflowStage(reopenedByFix.slice(0, -1), { maxTotalToolCalls: 99 }), 'recheck')
assert.equal(workflowStage(diagnosticsOnly, { maxTotalToolCalls: 2 }), 'final')

const repeated = [
  ...promoted,
  call('s1', 'pwsh', { command }, 20), result('s1', '[exit code: 0]', 21),
  call('s2', 'pwsh', { command }, 22), result('s2', '[exit code: 0]', 23),
]
const duplicatePersistedCall = [
  ...promoted,
  call('same-call', 'pwsh', { command }, 20),
  call('same-call', 'pwsh', { command }, 20),
  result('same-call', '[exit code: 0]', 21),
]
assert.equal(guardDecision(exec('pwsh', { command }, duplicatePersistedCall, 'new-call')), undefined)
assert.equal(guardDecision(exec('pwsh', { command }, repeated)), REPEAT_BLOCKED)
assert.equal(guardDecision(exec('pwsh', { command }, repeated), { maxPostCheckCalls: 99 }), REPEAT_BLOCKED)

// Request shaping occurs before generation and is stable; explicit audit values remain configurable.
assert.deepEqual(
  shapeRequest({ provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 256_000, reasoningEffort: 'max' }, { requestMaxTokens: 16_384, reasoningEffort: 'high' }),
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 16_384, reasoningEffort: 'max' },
)
assert.equal(shapeRequest({ maxTokens: 4_096 }, { requestMaxTokens: 16_384 }).maxTokens, 4_096)
assert.deepEqual(shapeRequest({ maxTokens: 256_000, reasoningEffort: 'max' }, { requestMaxTokens: 32_768 }), { maxTokens: 32_768, reasoningEffort: 'max' })

// HMR/dispose removes both waterfalls and the guard.
const registered = []
const disposed = []
const ctx = {
  on(event, listener) {
    registered.push({ event, listener })
    return () => disposed.push(event)
  },
  tools: {
    guard(listener) {
      registered.push({ event: 'tools.guard', listener })
      return () => disposed.push('tools.guard')
    },
  },
}
const dispose = apply(ctx, { requestMaxTokens: 16_384 })
assert.deepEqual(registered.map(entry => entry.event), ['system-prompt/assemble', 'agent/request', 'tools.guard'])
const requestHook = registered.find(entry => entry.event === 'agent/request').listener
const systemHook = registered.find(entry => entry.event === 'system-prompt/assemble').listener
const hookedAssembly = await systemHook(
  {},
  { agent: { options: { model: 'deepseek-v4-flash' }, session: { events: [] } } },
  async () => assembly,
)
assert.equal(hookedAssembly.sections[0].text, FLASH_PERSONA)
assert.deepEqual(
  await requestHook({ agent: { session: { events: [] } } }, async () => ({ maxTokens: 256_000, reasoningEffort: 'max' })),
  { maxTokens: 16_384, reasoningEffort: 'max' },
)
dispose()
assert.deepEqual(disposed, ['tools.guard', 'agent/request', 'system-prompt/assemble'])

console.log('production progressive guard tests passed')
