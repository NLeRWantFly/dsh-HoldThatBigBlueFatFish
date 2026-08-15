#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(process.env.COMPARISON_WORKSPACE
  ?? join(here, '..', '..', '..', '..', 'deepseek-harness'))
const routerRoot = resolve(process.env.ROUTER_ROOT
  ?? `${workspace}/dsh-router-standard`)
const modeltestRoot = resolve(process.env.MODELTEST_ROOT
  ?? `${workspace}/modeltest`)

const core = await import(pathToFileURL(`${routerRoot}/preset/router-core.mjs`))
const bootstrap = await import(pathToFileURL(`${routerRoot}/preset/router-bootstrap.mjs`))

const promptMarkdown = await readFile(`${modeltestRoot}/CANDIDATE_PROMPT.md`, 'utf8')
const fenced = promptMarkdown.match(/```text\s*\r?\n([\s\S]*?)\r?\n```/)
assert(fenced, 'Modeltest candidate prompt fence is missing')
const prompt = fenced[1]
const mode = core.classifyTask(prompt)

const listeners = new Map()
const registered = []
const session = {
  id: 'router-preflight',
  events: [{
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: prompt }],
    },
  }],
}
const inbox = { append() {} }
const agent = { session, inbox, options: { model: 'deepseek-v4-pro' } }
const ctx = {
  on(event, listener) {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
  effect(register) {
    register()
  },
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
  },
  llm: { stream() { throw new Error('preflight must not call a model') } },
  get(name) { return name === 'agent' ? agent : undefined },
}

bootstrap.apply(ctx, {})
assert.equal(typeof listeners.get('session/event'), 'function')
let eventError = null
try {
  listeners.get('session/event')(session, session.events[0])
} catch (error) {
  eventError = error
}

const result = {
  modelCalls: 0,
  routerModeForModeltest: mode,
  routerBandForModeltest: core.bandFor(mode),
  routerFirstCore: core.coreFor(mode),
  registeredRouterTools: registered.map(tool => tool.name),
  bootstrapEventPath: eventError === null
    ? { ok: true }
    : {
        ok: false,
        name: eventError.name,
        message: eventError.message,
      },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (eventError !== null) process.exitCode = 2
