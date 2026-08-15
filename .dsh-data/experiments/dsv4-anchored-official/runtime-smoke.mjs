#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MINIMAL_SYSTEM, PRESET_IDS, ROUTE } from './constants.mjs'
import { scoreTrajectory } from './lib.mjs'

const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const presetRoot = resolve(process.env.DSH_EXPERIMENT_PRESET_ROOT ?? '.dsh-data/.agent-presets')
const evaluationPlatform = process.platform === 'win32' ? 'windows-native' : 'linux-docker'
const nativeShell = process.platform === 'win32' ? 'pwsh' : 'bash'
const temporary = await mkdtemp(join(tmpdir(), 'dsv4-official-runtime-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(join(home, '.agent-presets'), { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'note.txt'), 'runtime smoke\n', 'utf8')
for (const preset of Object.values(PRESET_IDS)) {
  await cp(join(presetRoot, preset), join(home, '.agent-presets', preset), { recursive: true })
}

async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

const apiPort = await freePort()
const dshPort = await freePort()
let activeCondition
const captures = new Map()
const sessionEvents = new Map()
const api = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const rows = captures.get(activeCondition) ?? []
  rows.push(body)
  captures.set(activeCondition, rows)
  const first = rows.length === 1
  const usesBootstrap = activeCondition.endsWith('-anchored') || activeCondition === 'minimal-fixed'
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (activeCondition === 'probe-stop-check' || (first && usesBootstrap)) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'read the named file' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${activeCondition}-${rows.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'note.txt' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 20, completion_tokens_details: { reasoning_tokens: 4 } } })}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'finish' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 8, prompt_cache_hit_tokens: 30, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})
await new Promise(resolveReady => api.listen(apiPort, '127.0.0.1', resolveReady))

let stdout = ''
let stderr = ''
const dsh = spawn(process.execPath, [join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(dshPort)], {
  cwd: sourceRoot,
  windowsHide: true,
  env: {
    ...process.env,
    DSH_HOME: home,
    DEEPSEEK_API_KEY: 'runtime-smoke-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${apiPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
dsh.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-20000) })
dsh.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20000) })

const baseUrl = `http://127.0.0.1:${dshPort}`
async function rpc(method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}-${Math.random()}`, method, payload }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${method}: non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  if (body?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body)}`)
  return body.result.value
}

async function history(sessionId) {
  return (await rpc('session.history', { sessionId, maxMessages: 10000 })).events.map(entry => entry.event)
}

try {
  const started = Date.now()
  while (true) {
    if (dsh.exitCode !== null) throw new Error(`DSH exited ${dsh.exitCode}\n${stdout}\n${stderr}`)
    if (Date.now() - started > 60000) throw new Error(`DSH readiness timeout\n${stdout}\n${stderr}`)
    const ready = await fetch(`${baseUrl}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'readiness', method: 'session.history', payload: { sessionId: 'readiness-missing', maxMessages: 1 } }),
    }).then(async response => {
      try {
        const body = JSON.parse(await response.text())
        return body?.result !== undefined
      } catch {
        return false
      }
    }).catch(() => false)
    if (ready) break
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }

  for (const [condition, preset] of Object.entries(PRESET_IDS)) {
    activeCondition = condition
    const sessionId = `runtime-smoke-${condition}`
    await rpc('session.create', { sessionId, cwd: workspace, agentPreset: preset })
    await rpc('session.rename', { sessionId, title: `Runtime smoke ${condition}` })
    await rpc('session.selectModel', { sessionId, ...ROUTE })
    const sentAt = Date.now()
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'Read note.txt and finish.' }] })
    const waitStarted = Date.now()
    while (true) {
      const events = await history(sessionId)
      if (events.some(event => event.type === 'turn/end')) {
        sessionEvents.set(condition, { events, sessionId, sentAt })
        break
      }
      if (Date.now() - waitStarted > 30000) throw new Error(`${condition}: turn timeout`)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }

  activeCondition = 'probe-stop-check'
  const stopSession = 'probe-dsv4-official-runtime-stop'
  await rpc('session.create', { sessionId: stopSession, cwd: workspace, agentPreset: PRESET_IDS['standard-full'] })
  await rpc('session.rename', { sessionId: stopSession, title: 'Runtime probe stop' })
  await rpc('session.selectModel', { sessionId: stopSession, ...ROUTE })
  await rpc('session.prompt', { sessionId: stopSession, mode: 'queue', content: [{ type: 'text', text: 'Keep reading note.txt.' }] })
  const stopStarted = Date.now()
  while (true) {
    const events = await history(stopSession)
    if (events.some(event => event.type === 'turn/end')) {
      assert.equal(events.filter(event => event.type === 'assistant/message').length, 3, 'probe stop assistant count')
      break
    }
    if (Date.now() - stopStarted > 30000) throw new Error('probe stop turn timeout')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }

  const standard = captures.get('standard-full')[0]
  const standardTools = standard.tools
  for (const [condition, requests] of captures) {
    assert.equal(requests[0].model, ROUTE.model, `${condition}: model`)
    assert.equal(requests[0].reasoning_effort, 'max', `${condition}: effort`)
    const firstSystem = requests[0].messages.find(message => message.role === 'system')?.content
    if (condition.startsWith('minimal-')) {
      assert.equal(firstSystem, MINIMAL_SYSTEM, `${condition}: exact Minimal system`)
      assert(!requests[0].messages.some(message => message.role === 'user' && String(message.content).startsWith('Current runtime context.')), `${condition}: runtime context`)
    } else {
      assert.notEqual(firstSystem, MINIMAL_SYSTEM, `${condition}: Standard system`)
      assert(String(firstSystem).includes('You are a coding agent powered by'), `${condition}: Standard identity`)
    }
    if (condition.endsWith('-anchored') || condition === 'minimal-fixed') {
      assert.deepEqual(requests[0].tools.map(tool => tool.function.name).sort(), [nativeShell, 'read'].sort(), `${condition}: first tools`)
      assert(requests.length >= 2, `${condition}: expected a following request`)
      const secondTools = requests[1].tools
      if (condition.endsWith('-anchored')) assert.deepEqual(secondTools, standardTools, `${condition}: promoted Standard schemas`)
      else assert.deepEqual(secondTools, requests[0].tools, `${condition}: fixed schemas`)
      if (condition === 'minimal-anchored') {
        assert.equal(requests[1].messages.find(message => message.role === 'system')?.content, MINIMAL_SYSTEM)
      }
    } else {
      assert.deepEqual(requests[0].tools, standardTools, `${condition}: full schemas`)
    }
  }
  for (const condition of ['standard-anchored', 'minimal-anchored']) {
    const captured = sessionEvents.get(condition)
    const score = scoreTrajectory({
      id: `runtime-${condition}`,
      suite: 'probe',
      platform: evaluationPlatform,
      condition,
      repeat: 1,
      prompt: 'Read note.txt and finish.',
      sessionId: captured.sessionId,
      eventFile: 'runtime-smoke',
      sentAt: captured.sentAt,
    }, captured.events)
    assert.equal(score.promotion.durableToolCallSeen, true, `${condition}: durable event`)
    assert.equal(score.promotion.promotedOnFollowingRequest, true, `${condition}: event-derived next-request promotion`)
  }
  assert.equal(captures.get('probe-stop-check').length, 3, 'probe stop provider request count')
  console.log(JSON.stringify({
    ok: true,
    standardToolCount: standardTools.length,
    requestCounts: Object.fromEntries([...captures].map(([condition, requests]) => [condition, requests.length])),
    minimalSystemChars: MINIMAL_SYSTEM.length,
  }, null, 2))
} finally {
  dsh.kill('SIGTERM')
  await new Promise(resolveExit => dsh.once('exit', resolveExit)).catch(() => undefined)
  await new Promise(resolveClose => api.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}
