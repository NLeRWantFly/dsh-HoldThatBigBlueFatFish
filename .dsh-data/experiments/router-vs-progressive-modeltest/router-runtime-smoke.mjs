#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(process.env.DSH_SOURCE_ROOT
  ?? join(homedir(), 'Documents', 'Codex', '2026-08-13', 'ba', 'work', 'deepseek-harness'))
const workspaceRoot = resolve(process.env.COMPARISON_WORKSPACE
  ?? join(here, '..', '..', '..', '..', 'deepseek-harness'))
const routerRoot = resolve(process.env.ROUTER_ROOT ?? `${workspaceRoot}/dsh-router-standard`)
const modeltestRoot = resolve(process.env.MODELTEST_ROOT ?? `${workspaceRoot}/modeltest`)
const promptMarkdown = await readFile(`${modeltestRoot}/CANDIDATE_PROMPT.md`, 'utf8')
const prompt = promptMarkdown.match(/```text\s*\r?\n([\s\S]*?)\r?\n```/)?.[1]
if (!prompt) throw new Error('Modeltest candidate prompt is missing')

async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

const temporary = await mkdtemp(join(tmpdir(), 'router-runtime-smoke-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(join(home, '.agent-presets'), { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'ONBOARDING_TODO.md'), '# Bounded task evidence\n', 'utf8')
await cp(join(routerRoot, 'preset'), join(home, '.agent-presets', 'dsh-router-standard'), { recursive: true })

const apiPort = await freePort()
const dshPort = await freePort()
const requests = []
const api = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requests.push(body)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const index = requests.filter(entry => Array.isArray(entry.tools) && entry.tools.length > 0).length
  if (index === 1) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'read named evidence' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'ONBOARDING_TODO.md' }) } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 50, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 3 } },
    })}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 2 } })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})
await new Promise(resolveReady => api.listen(apiPort, '127.0.0.1', resolveReady))

let stderr = ''
const dsh = spawn(process.execPath, [join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(dshPort)], {
  cwd: sourceRoot,
  windowsHide: true,
  env: {
    ...process.env,
    DSH_HOME: home,
    DEEPSEEK_API_KEY: 'router-runtime-smoke-placeholder',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${apiPort}`,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
dsh.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000) })
const baseUrl = `http://127.0.0.1:${dshPort}`

async function rpc(method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `${Date.now()}-${Math.random()}`, method, payload }),
  })
  const body = await response.json()
  if (body?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body)}`)
  return body.result.value
}

async function history(sessionId) {
  return (await rpc('session.history', { sessionId, maxMessages: 2000 })).events.map(entry => entry.event)
}

let promptError = null
let events = []
try {
  const readyAt = Date.now()
  while (true) {
    if (dsh.exitCode !== null) throw new Error(`DSH exited ${dsh.exitCode}: ${stderr}`)
    const ready = await fetch(`${baseUrl}/api/session.history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'ready', method: 'session.history', payload: { sessionId: 'missing', maxMessages: 1 } }),
    }).then(async response => (await response.json())?.result !== undefined).catch(() => false)
    if (ready) break
    if (Date.now() - readyAt > 60_000) throw new Error(`readiness timeout: ${stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }

  const sessionId = 'router-runtime-smoke'
  await rpc('session.create', { sessionId, cwd: workspace, agentPreset: 'dsh-router-standard' })
  await rpc('session.selectModel', { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  try {
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] })
  } catch (error) {
    promptError = error.message
  }
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    events = await history(sessionId)
    if (events.some(event => event.type === 'turn/end')) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }

  const agentRequests = requests.filter(request => Array.isArray(request.tools) && request.tools.length > 0)
  const result = {
    modelCalls: agentRequests.length,
    promptError,
    turnEnded: events.some(event => event.type === 'turn/end'),
    turnEndReasons: events.filter(event => event.type === 'turn/end').map(event => event.data?.reason),
    firstTools: agentRequests[0]?.tools?.map(tool => tool.function.name) ?? [],
    laterTools: agentRequests[1]?.tools?.map(tool => tool.function.name) ?? [],
    firstSystemChars: agentRequests[0]?.messages?.find(message => message.role === 'system')?.content?.length ?? null,
    requestReasoningEffort: agentRequests.map(request => request.reasoning_effort ?? request.reasoningEffort ?? null),
    referenceErrorsInStderr: (stderr.match(/ReferenceError/g) ?? []).length,
    stderrTail: stderr.slice(-4000),
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.turnEnded || result.modelCalls === 0) process.exitCode = 2
} finally {
  dsh.kill('SIGTERM')
  await new Promise(resolveExit => dsh.once('exit', resolveExit)).catch(() => undefined)
  await new Promise(resolveClose => api.close(resolveClose))
  await rm(temporary, { recursive: true, force: true })
}
