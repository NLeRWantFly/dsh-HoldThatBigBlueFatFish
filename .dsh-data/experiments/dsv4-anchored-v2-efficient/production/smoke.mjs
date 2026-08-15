#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve(here, '..', '..', '..', '.agent-presets')
const preset = 'dsv4-progressive-guarded'
const temporary = await mkdtemp(join(tmpdir(), 'dsv4-production-smoke-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(join(home, '.agent-presets'), { recursive: true })
await mkdir(workspace, { recursive: true })
await cp(join(presetRoot, preset), join(home, '.agent-presets', preset), { recursive: true })
await writeFile(join(workspace, 'note.txt'), 'bounded evidence\n', 'utf8')

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
let agentRequest = 0
const api = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requests.push(body)
  const isAgent = Array.isArray(body.tools) && body.tools.length > 0
  if (isAgent) agentRequest++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (isAgent && agentRequest === 1) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'read bounded evidence' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'note.txt' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`)
  } else if (isAgent && agentRequest === 2) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'attempt broad inventory' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-broad-shell', type: 'function', function: { name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem -Recurse -Force', description: 'inventory' }) } },
      { index: 1, id: 'call-broad-glob', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*' }) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 60, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 4 } } })}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'finish after containment' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})
await new Promise(resolveReady => api.listen(apiPort, '127.0.0.1', resolveReady))

let stderr = ''
const dsh = spawn(process.execPath, [join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(dshPort)], {
  cwd: sourceRoot,
  windowsHide: true,
  env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'production-smoke-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${apiPort}` },
  stdio: ['ignore', 'ignore', 'pipe'],
})
dsh.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-10000) })
const baseUrl = `http://127.0.0.1:${dshPort}`

async function rpc(method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}-${Math.random()}`, method, payload }) })
  const body = JSON.parse(await response.text())
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
      body: JSON.stringify({ type: 'client-request', rpcId: 'ready', method: 'session.history', payload: { sessionId: 'missing', maxMessages: 1 } }),
    }).then(async response => JSON.parse(await response.text())?.result !== undefined).catch(() => false)
    if (ready) break
    if (Date.now() - readyAt > 60000) throw new Error(`readiness timeout: ${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }

  const sessionId = 'production-progressive-smoke'
  await rpc('session.create', { sessionId, cwd: workspace, agentPreset: preset })
  await rpc('session.selectModel', { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'Read note.txt, then continue with bounded checks.' }] })
  const started = Date.now()
  let history
  while (true) {
    history = await events(sessionId)
    if (history.some(event => event.type === 'turn/end')) break
    if (Date.now() - started > 30000) throw new Error('turn timeout')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }

  const agentRequests = requests.filter(request => Array.isArray(request.tools) && request.tools.length > 0)
  assert.equal(agentRequests.length, 3)
  assert.deepEqual(agentRequests[0].tools.map(tool => tool.function.name).sort(), ['pwsh', 'read'])
  const core = ['edit', 'glob', 'grep', 'pwsh', 'read', 'write']
  assert.deepEqual(agentRequests[1].tools.map(tool => tool.function.name).sort(), core)
  assert.deepEqual(agentRequests[2].tools, agentRequests[1].tools)
  const systems = agentRequests.map(request => request.messages.find(message => message.role === 'system')?.content ?? '')
  assert.deepEqual([...new Set(systems)], ['You are a helpful software engineer assistant.'])
  const denialText = history.filter(event => event.type === 'tool/result').map(event => JSON.stringify(event.data?.message?.content ?? '')).join('\n')
  assert.match(denialText, /PROGRESSIVE_INVENTORY_BLOCKED/)
  assert.equal((denialText.match(/PROGRESSIVE_INVENTORY_BLOCKED/g) ?? []).length, 2)
  const firstResult = history.find(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('call-read'))
  const changedHeader = history.find(event => event.type === 'request/header' && event.data?.reason === 'change')
  assert(firstResult.seq < changedHeader.seq)
  const result = { ok: true, agentRequests: agentRequests.length, firstTools: ['pwsh', 'read'], promotedTools: core, inventoryDenials: 2 }
  await writeFile(join(here, 'smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(result, null, 2))
} finally {
  dsh.kill('SIGTERM')
  await new Promise(resolveExit => dsh.once('exit', resolveExit)).catch(() => undefined)
  await new Promise(resolveClose => api.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}
