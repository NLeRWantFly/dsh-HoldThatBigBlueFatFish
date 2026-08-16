#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MINIMAL_SYSTEM, PRESET_ID } from './install.mjs'

const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const deployedHome = resolve(process.env.DSH_TARGET_HOME ?? join(sourceRoot, '.dsh-data'))

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function cliBinFor(root) {
  const candidates = [
    join(root, 'apps', 'cli', 'lib', 'bin.js'),
    join(root, 'lib', 'bin.js'),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  throw new Error(`could not find dsh CLI bin.js under ${root}; tried:\n${candidates.join('\n')}`)
}
const temporary = await mkdtemp(join(tmpdir(), 'dsv4-pro-anchored-96-smoke-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(join(home, '.agent-presets'), { recursive: true })
await mkdir(workspace, { recursive: true })
await cp(join(deployedHome, '.agent-presets', PRESET_ID), join(home, '.agent-presets', PRESET_ID), { recursive: true })

async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

const apiPort = await freePort()
const dshPort = await freePort()
const requests = []
const api = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requests.push(body)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (requests.length === 1) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Run the required interpreter check.' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-shell-smoke', type: 'function', function: { name: 'pwsh', arguments: JSON.stringify({ command: "Write-Output 'anchored-smoke-ok'", description: 'Run deterministic shell smoke marker' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_cache_hit_tokens: 0, completion_tokens_details: { reasoning_tokens: 5 } } })}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 3, prompt_cache_hit_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})
await new Promise(resolveReady => api.listen(apiPort, '127.0.0.1', resolveReady))

const childEnv = {
  ...process.env,
  DSH_HOME: home,
  DEEPSEEK_API_KEY: 'runtime-smoke-key',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${apiPort}`,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
}
let stdout = ''
let stderr = ''
const dsh = spawn(process.execPath, [await cliBinFor(sourceRoot), 'web', '--host', '127.0.0.1', '--port', String(dshPort)], {
  cwd: sourceRoot,
  windowsHide: true,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})
dsh.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-30000) })
dsh.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-30000) })

const baseUrl = `http://127.0.0.1:${dshPort}`
async function rpc(method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}-${Math.random()}`, method, payload }),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body)}`)
  return body.result.value
}

async function history(sessionId) {
  return (await rpc('session.history', { sessionId, maxMessages: 1000 })).events.map(row => row.event)
}

let approvalSocket
try {
  const readyAt = Date.now()
  while (true) {
    if (dsh.exitCode !== null) throw new Error(`DSH exited ${dsh.exitCode}\n${stdout}\n${stderr}`)
    const ready = await fetch(`${baseUrl}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'ready', method: 'session.history', payload: { sessionId: 'missing', maxMessages: 1 } }),
    }).then(async response => (await response.json())?.result !== undefined).catch(() => false)
    if (ready) break
    if (Date.now() - readyAt > 60000) throw new Error(`DSH readiness timeout\n${stdout}\n${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }

  const eventUrl = new URL('/api/events.mux', baseUrl)
  eventUrl.protocol = 'ws:'
  approvalSocket = new WebSocket(eventUrl)
  await new Promise((resolveReady, rejectReady) => {
    approvalSocket.addEventListener('open', resolveReady, { once: true })
    approvalSocket.addEventListener('error', () => rejectReady(new Error('approval websocket failed')), { once: true })
  })
  approvalSocket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return
    const envelope = JSON.parse(event.data)
    const request = envelope?.payload
    if (envelope?.type !== 'server-request' || request?.type !== 'approval/requested') return
    void fetch(new URL('/api/respond', baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response', rpcId: envelope.rpcId,
        result: { ok: true, value: { sessionId: request.sessionId, approvalId: request.approvalId, outcome: request.toolName === 'pwsh' ? 'allowed-once' : 'rejected' } },
      }),
    })
  })

  const sessionId = 'dsv4-pro-anchored-96-smoke'
  await rpc('session.create', { sessionId, cwd: workspace, agentPreset: PRESET_ID })
  await rpc('session.selectModel', { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'Check Python, then finish.' }] })

  const turnAt = Date.now()
  let events
  while (true) {
    events = await history(sessionId)
    if (events.some(event => event.type === 'turn/end')) break
    if (Date.now() - turnAt > 60000) throw new Error(`turn timeout\n${stdout}\n${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }

  const agentRequests = requests.filter(request => Array.isArray(request.tools) && request.tools.length > 0)
  assert.equal(agentRequests.length, 2)
  const firstSystem = agentRequests[0].messages.find(message => message.role === 'system')?.content
  const secondSystem = agentRequests[1].messages.find(message => message.role === 'system')?.content
  assert.equal(firstSystem, MINIMAL_SYSTEM)
  assert.equal(secondSystem, MINIMAL_SYSTEM)
  assert.deepEqual(agentRequests[0].tools.map(tool => tool.function.name).sort(), ['pwsh', 'read'])
  assert(agentRequests[1].tools.length > agentRequests[0].tools.length, 'full Standard catalog was not restored')
  assert(agentRequests[1].tools.some(tool => tool.function.name === 'edit'))
  assert.match(JSON.stringify(events), /anchored-smoke-ok/)
  console.log(JSON.stringify({
    ok: true,
    firstTools: agentRequests[0].tools.map(tool => tool.function.name),
    promotedToolCount: agentRequests[1].tools.length,
    shellMarker: 'anchored-smoke-ok',
    systemChars: firstSystem.length,
  }, null, 2))
} finally {
  approvalSocket?.close(1000, 'complete')
  dsh.kill('SIGTERM')
  if (dsh.exitCode === null) await new Promise(resolveExit => dsh.once('exit', resolveExit)).catch(() => undefined)
  await new Promise(resolveClose => api.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}
