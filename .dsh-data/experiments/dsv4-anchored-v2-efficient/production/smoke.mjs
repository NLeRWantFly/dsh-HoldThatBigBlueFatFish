#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERSONA } from './progressive-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve(process.env.DSH_PRESET_ROOT ?? join(here, '..', '..', '..', '.agent-presets'))
const preset = 'dsv4-progressive-guarded'
const nativeShell = process.platform === 'win32' ? 'pwsh' : 'bash'
const probeCommand = process.platform === 'win32'
  ? 'Get-ChildItem -Force | Select-Object -First 50 Name,Mode,Length'
  : 'find . -maxdepth 1 -mindepth 1 -print | head -n 50'
const locationCommand = process.platform === 'win32' ? 'Get-Location' : 'pwd'
const temporary = await mkdtemp(join(tmpdir(), 'dsv4-production-smoke-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(join(home, '.agent-presets'), { recursive: true })
await mkdir(workspace, { recursive: true })
await cp(join(presetRoot, preset), join(home, '.agent-presets', preset), { recursive: true })

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

function assistantToolResponse(response, reasoning, calls, usage = {}) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: calls.map((entry, index) => ({
          index,
          id: entry.id,
          type: 'function',
          function: { name: entry.name, arguments: JSON.stringify(entry.arguments) },
        })),
      },
      finish_reason: 'tool_calls',
    }],
    usage: {
      prompt_tokens: usage.prompt ?? 50,
      completion_tokens: usage.completion ?? 10,
      completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 3 },
    },
  })}\n\n`)
}

function assistantTextResponse(response, reasoning, text) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 70, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } },
  })}\n\n`)
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
    assistantToolResponse(response, 'bounded empty-project probe', [{
      id: 'call-probe',
      name: nativeShell,
      arguments: {
        command: probeCommand,
        description: 'Inspect immediate workspace entries',
      },
    }])
  } else if (isAgent && agentRequest === 2) {
    assistantToolResponse(response, 'attempt oversized implementation', [{
      id: 'call-oversized',
      name: 'write',
      arguments: { file_path: 'app.js', content: 'x'.repeat(12_001) },
    }])
  } else if (isAgent && agentRequest === 3) {
    assistantToolResponse(response, 'write one vertical slice', [{
      id: 'call-small-write',
      name: 'write',
      arguments: { file_path: 'app.js', content: "console.log('ok')\n" },
    }])
  } else if (isAgent && agentRequest === 4) {
    assistantToolResponse(response, 'run the relevant check', [{
      id: 'call-check',
      name: nativeShell,
      arguments: { command: 'node --check app.js', description: 'Check JavaScript syntax' },
    }])
  } else if (isAgent && agentRequest === 5) {
    assistantToolResponse(response, 'attempt three different speculative audits', [
      { id: 'call-audit-read', name: 'read', arguments: { file_path: 'app.js' } },
      { id: 'call-audit-grep', name: 'grep', arguments: { pattern: 'console', path: 'app.js' } },
      { id: 'call-audit-shell', name: nativeShell, arguments: { command: locationCommand, description: 'Show current location' } },
    ])
  } else {
    assistantTextResponse(response, 'finish after bounded verification', 'done')
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
  return (await rpc('session.history', { sessionId, maxMessages: 2000 })).events.map(entry => entry.event)
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
    if (Date.now() - readyAt > 60_000) throw new Error(`readiness timeout: ${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }

  const sessionId = 'production-progressive-smoke'
  await rpc('session.create', { sessionId, cwd: workspace, agentPreset: preset })
  await rpc('session.selectModel', { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'Create the smallest checked JavaScript program in this empty project.' }] })
  const started = Date.now()
  let history
  while (true) {
    history = await events(sessionId)
    if (history.some(event => event.type === 'turn/end')) break
    if (Date.now() - started > 30_000) throw new Error('turn timeout')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }

  const agentRequests = requests.filter(request => Array.isArray(request.tools) && request.tools.length > 0)
  assert.equal(agentRequests.length, 6)
  assert.deepEqual(agentRequests[0].tools.map(tool => tool.function.name).sort(), [nativeShell, 'read'].sort())
  const initialShell = agentRequests[0].tools.find(tool => tool.function.name === nativeShell).function
  assert.deepEqual(Object.keys(initialShell.parameters.properties).sort(), ['command', 'description', 'timeoutMs', 'workdir'])
  assert.equal(initialShell.parameters.additionalProperties, false)
  assert.doesNotMatch(initialShell.description, /DSH_|environment facts/i)

  const core = ['edit', 'glob', 'grep', nativeShell, 'read', 'write'].sort()
  assert.deepEqual(agentRequests[1].tools.map(tool => tool.function.name).sort(), core)
  for (const request of agentRequests.slice(2)) assert.deepEqual(request.tools, agentRequests[1].tools)
  const promotedShell = agentRequests[1].tools.find(tool => tool.function.name === nativeShell).function
  const initialShellSchemaBytes = Buffer.byteLength(JSON.stringify(initialShell))
  const promotedShellSchemaBytes = Buffer.byteLength(JSON.stringify(promotedShell))
  assert(initialShellSchemaBytes < promotedShellSchemaBytes)
  const writeSchema = agentRequests[1].tools.find(tool => tool.function.name === 'write').function
  assert.equal(writeSchema.parameters.properties.content.maxLength, 12_000)

  const systems = agentRequests.map(request => request.messages.find(message => message.role === 'system')?.content ?? '')
  assert.deepEqual([...new Set(systems)], [PERSONA])
  const headers = history.filter(event => event.type === 'request/header')
  assert.equal(headers.length, 2)
  assert(headers.every(event => event.data.header.config.maxTokens === 16_384))
  assert.deepEqual(headers.map(event => event.data.header.config.reasoningEffort), ['high', 'high'])

  const denialText = history.filter(event => event.type === 'tool/result').map(event => JSON.stringify(event.data?.message?.content ?? '')).join('\n')
  assert.equal((denialText.match(/PROGRESSIVE_MUTATION_TOO_LARGE/g) ?? []).length, 1)
  assert.equal((denialText.match(/PROGRESSIVE_STOP_AFTER_CHECK/g) ?? []).length, 1)
  const probeResult = history.find(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('call-probe'))
  const changedHeader = headers.find(event => event.data?.reason === 'change')
  assert(probeResult.seq < changedHeader.seq)

  const toolHashes = [...new Set(agentRequests.map(request => sha256(JSON.stringify(request.tools))))]
  assert.equal(toolHashes.length, 2)
  const result = {
    ok: true,
    agentRequests: agentRequests.length,
    requestHeaders: headers.length,
    schemaTransitions: toolHashes.length - 1,
    platform: process.platform,
    firstTools: [nativeShell, 'read'].sort(),
    promotedTools: core,
    maxTokens: 16_384,
    reasoningEffort: 'high',
    emptyWorkspacePromotion: true,
    oversizedMutationDenials: 1,
    convergenceDenials: 1,
    systemSha256: sha256(PERSONA),
    initialShellSchemaBytes,
    promotedShellSchemaBytes,
    toolSchemaSha256: toolHashes,
  }
  await writeFile(join(here, 'smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(result, null, 2))
} finally {
  dsh.kill('SIGTERM')
  await new Promise(resolveExit => dsh.once('exit', resolveExit)).catch(() => undefined)
  await new Promise(resolveClose => api.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}
