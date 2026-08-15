#!/usr/bin/env node
import assert from 'node:assert/strict'
import { PORTABLE_BASH_REJECTED, apply, translatePortableBash } from './portable-bash.mjs'

assert.equal(translatePortableBash('git status --short'), 'git status --short')
assert.equal(translatePortableBash('python tests/run_public_tests.py project2_task'), 'python tests/run_public_tests.py project2_task')
assert.equal(translatePortableBash('node --check src/app.js && npm test'), process.platform === 'win32'
  ? 'node --check src/app.js && npm.cmd test'
  : 'node --check src/app.js && npm test')
assert.equal(translatePortableBash('node -e "const f = x => x; console.log(f(1))"'), 'node -e "const f = x => x; console.log(f(1))"')
assert.equal(translatePortableBash('pwd'), '(Get-Location).Path')
assert.equal(
  translatePortableBash('find . -maxdepth 1 -mindepth 1 -print | head -n 50'),
  "Get-ChildItem -LiteralPath '.' -Force | Select-Object -First 50 Name,Mode,Length",
)
assert.equal(
  translatePortableBash('ls -la ./src | head -n 20'),
  "Get-ChildItem -LiteralPath './src' -Force | Select-Object -First 20 Name,Mode,Length",
)

for (const command of [
  'find . -type f',
  'cat package.json',
  'echo $DSH_SESSION_JSONL',
  'node test.js | tee out.txt',
  'python test.py > result.txt',
  'Get-ChildItem -Recurse',
  'git status; whoami',
  'git status || whoami',
]) assert.throws(() => translatePortableBash(command), error => error.message === PORTABLE_BASH_REJECTED)
assert.throws(
  () => translatePortableBash('find . -maxdepth 1 -print | head -n 51'),
  error => error.message === PORTABLE_BASH_REJECTED,
)

let registered
let disposed = false
let nested
const ctx = {
  tools: {
    register(definition) {
      registered = definition
      return () => { disposed = true }
    },
    async execute(input) {
      nested = input
      return { isError: false, value: 'native', content: [{ type: 'text', text: 'ok\n[exit code: 0]' }] }
    },
  },
}
const dispose = apply(ctx)
assert.equal(registered.name, 'bash')
assert.match(registered.description, /Linux-style portable developer command/)
assert.match(registered.description, /sandbox escalation .* unsupported/)
assert.equal(registered.parameters.additionalProperties, false)
assert.equal(registered.parameters.properties.sandbox_permissions, undefined)
const deferred = []
let concluded = false
const signal = new AbortController().signal
const output = await registered.execute(
  { command: 'git status --short', description: 'Show working tree status' },
  {
    callId: 'outer', rootCallId: 'outer', token: Symbol('outer'), signal,
    deferContext: context => deferred.push(context),
    concludeTurn: () => { concluded = true },
  },
)
assert.equal(output, 'ok\n[exit code: 0]')
assert.equal(nested.name, 'pwsh')
assert.equal(nested.callId, 'outer:pwsh')
assert.equal(nested.arguments.command, 'git status --short')
assert.equal(nested.arguments.sandbox_permissions, undefined)
assert.equal(nested.signal, signal)
assert.deepEqual(deferred, [])
assert.equal(concluded, false)
dispose()
assert.equal(disposed, true)

console.log('portable bash tests passed')
