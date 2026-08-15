#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { CAPABILITY_NOTE, COMPACT_CONTRACT, MINIMAL_PERSONA, PRESETS, ROUTE, SINGLE_ACTION_CONTRACT } from './constants.mjs'

const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve('.dsh-data/.agent-presets')
const temporary = await mkdtemp(join(tmpdir(), 'dsv4-v2-smoke-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(join(home, '.agent-presets'), { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'note.txt'), 'evidence\n', 'utf8')
await writeFile(join(workspace, 'ONBOARDING_TODO.md'), 'prefetched evidence\n', 'utf8')
for (const preset of Object.values(PRESETS)) await cp(join(presetRoot, preset), join(home, '.agent-presets', preset), { recursive: true })

async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

const apiPort = await freePort()
const dshPort = await freePort()
let condition
const captures = new Map()
const api = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const rows = captures.get(condition) ?? []
  rows.push(body)
  captures.set(condition, rows)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (rows.length === 1) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'read one named file' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${condition}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'note.txt' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 4 } } })}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'finish' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})
await new Promise(resolveReady => api.listen(apiPort, '127.0.0.1', resolveReady))

let stderr = ''
const dsh = spawn(process.execPath, [join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(dshPort)], {
  cwd: sourceRoot,
  windowsHide: true,
  env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'runtime-smoke-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${apiPort}` },
  stdio: ['ignore', 'ignore', 'pipe'],
})
dsh.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-10000) })
const baseUrl = `http://127.0.0.1:${dshPort}`

async function rpc(method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}-${Math.random()}`, method, payload }) })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`${method}: HTTP ${response.status}: ${text.slice(0, 200)}`) }
  if (body?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body)}`)
  return body.result.value
}

async function events(sessionId) {
  return (await rpc('session.history', { sessionId, maxMessages: 1000 })).events.map(entry => entry.event)
}

try {
  const readyAt = Date.now()
  while (true) {
    if (dsh.exitCode !== null) throw new Error(`DSH exited ${dsh.exitCode}: ${stderr}`)
    const ready = await fetch(`${baseUrl}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'readiness', method: 'session.history', payload: { sessionId: 'missing-readiness', maxMessages: 1 } }),
    }).then(async response => {
      try { return JSON.parse(await response.text())?.result !== undefined } catch { return false }
    }).catch(() => false)
    if (ready) break
    if (Date.now() - readyAt > 60000) throw new Error(`readiness timeout: ${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }

  const histories = new Map()
  for (const [name, preset] of Object.entries(PRESETS)) {
    condition = name
    const sessionId = `runtime-v2-${name}`
    await rpc('session.create', { sessionId, cwd: workspace, agentPreset: preset })
    await rpc('session.selectModel', { sessionId, ...ROUTE })
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'Read note.txt, then finish.' }] })
    const started = Date.now()
    while (true) {
      const rows = await events(sessionId)
      if (rows.some(event => event.type === 'turn/end')) { histories.set(name, rows); break }
      if (Date.now() - started > 30000) throw new Error(`${name}: timeout`)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }

  let referenceCore
  for (const [name, requests] of captures) {
    const modelRequests = requests.filter(request => Array.isArray(request.messages) && Array.isArray(request.tools) && request.tools.length > 0)
    if (name === 'v3-single-core') {
      assert.equal(modelRequests.length, 1, `${name}: expected one request; ${JSON.stringify(modelRequests.map(request => ({ tools: request.tools.map(tool => tool.function?.name), last: request.messages.at(-1)?.role, lastContent: request.messages.at(-1)?.content })))}`)
      assert.deepEqual(modelRequests[0].tools.map(tool => tool.function.name).sort(), ['pwsh', 'read'].sort())
      const system = modelRequests[0].messages.find(message => message.role === 'system')?.content ?? ''
      assert(system.includes(SINGLE_ACTION_CONTRACT))
      assert.equal(histories.get(name).filter(event => event.type === 'assistant/message').length, 1)
      continue
    }
    assert.equal(modelRequests.length, 2, `${name}: unexpected agent request count ${modelRequests.length}`)
    const firstNames = name === 'v6-prefetched-core'
      ? ['edit', 'glob', 'grep', 'pwsh', 'read', 'write']
      : name === 'v4-read-core' || name === 'v5-read-noted-core'
        ? ['read']
        : ['pwsh', 'read']
    assert.deepEqual(modelRequests[0].tools.map(tool => tool.function.name).sort(), firstNames.sort())
    assert.deepEqual(modelRequests[1].tools.map(tool => tool.function.name).sort(), ['edit', 'glob', 'grep', 'pwsh', 'read', 'write'].sort())
    referenceCore ??= modelRequests[1].tools
    for (const request of modelRequests.slice(1)) assert.deepEqual(request.tools, referenceCore, `${name}: core schemas differ`)
    const system = modelRequests[0].messages.find(message => message.role === 'system')?.content ?? ''
    assert.equal(system.includes(COMPACT_CONTRACT), name === 'v2-compact-core')
    if (name === 'v4-read-core') assert.equal(system, MINIMAL_PERSONA)
    if (name === 'v5-read-noted-core') assert.equal(system, `${MINIMAL_PERSONA} ${CAPABILITY_NOTE}`)
    if (name === 'v6-prefetched-core') {
      assert(system.startsWith(MINIMAL_PERSONA))
      assert(system.includes('Prefetched workspace evidence from ONBOARDING_TODO.md:'))
      assert(system.includes('prefetched evidence'))
      assert(!system.includes('Harness Identity'))
      assert.equal(histories.get(name).filter(event => event.type === 'request/header').length, 1)
      continue
    }
    const rows = histories.get(name)
    const result = rows.find(event => event.type === 'tool/result')
    const secondHeader = rows.filter(event => event.type === 'request/header')[1]
    assert(result.seq < secondHeader.seq, `${name}: promotion preceded evidence result`)
  }
  console.log(JSON.stringify({ ok: true, requests: Object.fromEntries([...captures].map(([key, value]) => [key, value.length])), coreToolCount: referenceCore.length }, null, 2))
} finally {
  dsh.kill('SIGTERM')
  await new Promise(resolveExit => dsh.once('exit', resolveExit)).catch(() => undefined)
  await new Promise(resolveClose => api.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}
