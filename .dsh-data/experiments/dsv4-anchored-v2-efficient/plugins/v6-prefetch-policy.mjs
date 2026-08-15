import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export const name = 'dsv4-official-v6-prefetch-policy'
export const inject = ['systemPrompt', 'tools']

export const BUDGET_DENIAL = 'V6_FIRST_RESPONSE_BUDGET: use at most two bounded calls.'
export const INVENTORY_DENIAL = 'V6_INVENTORY: recursive directory inventory and background work are unavailable.'
export const REPEAT_DENIAL = 'V6_NO_PROGRESS_REPEAT: choose a different check or make a code change before repeating this command.'

const BROAD_SHELL = [
  /\b(?:get-childitem|gci)\b[^\r\n;&|]*-recurse\b/i,
  /\b(?:get-childitem|gci)\b[^\r\n;&|]*(?:select-object\s+(?:mode|name|fullname)|format-table)/i,
  /\bdir(?:\.exe)?\s+\/s(?:\s|$)/i,
  /(?:^|[;&|]\s*)tree(?:\.com|\.exe)?(?:\s|$)/i,
  /\brg(?:\.exe)?\b[^\r\n;&|]*\s--files\b/i,
  /\bgit\s+ls-files\b/i,
  /(?:^|[;&|]\s*)find(?:\.exe)?\s+\.(?:[\\/\s]|$)/i,
  /(?:^|[;&|]\s*)ls\s+-[A-Za-z]*R[A-Za-z]*(?:\s|$)/,
]

function parseArguments(value) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value
  if (typeof value !== 'string') return {}
  try { return JSON.parse(value) } catch { return {} }
}

function assistantCallContext(events, callId) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const calls = event.data?.message?.content?.filter?.(block => block?.type === 'tool-call') ?? []
    const callIndex = calls.findIndex(block => block.id === callId)
    if (callIndex >= 0) return { callIndex, step: event.data?.step }
  }
  return undefined
}

function repeatedShell(events, exec) {
  if (exec.name !== 'bash' && exec.name !== 'pwsh') return false
  const command = String(exec.arguments?.command ?? '').trim().replace(/\s+/g, ' ')
  if (!command) return false
  let repeats = 0
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    const tool = String(event.data?.name ?? '')
    if (tool === 'edit' || tool === 'write') break
    if (tool !== exec.name) continue
    const previous = String(parseArguments(event.data?.arguments).command ?? '').trim().replace(/\s+/g, ' ')
    if (previous === command) repeats++
  }
  return repeats >= 2
}

export function guardDecision(exec) {
  const events = exec?.agent?.session?.events
  if (!Array.isArray(events)) return undefined
  const context = assistantCallContext(events, exec.callId)
  if (context?.step === 1 && context.callIndex >= 2) return BUDGET_DENIAL
  if (exec.name === 'bash' || exec.name === 'pwsh') {
    if (exec.arguments?.run_in_background === true) return INVENTORY_DENIAL
    if (BROAD_SHELL.some(pattern => pattern.test(String(exec.arguments?.command ?? '')))) return INVENTORY_DENIAL
    if (repeatedShell(events, exec)) return REPEAT_DENIAL
  }
  return undefined
}

function selectedTools(assembled, config) {
  const available = new Set(assembled.tools.map(tool => tool.name))
  const shells = (config.shellTools ?? ['bash', 'pwsh']).filter(tool => available.has(tool))
  if (shells.length !== 1) throw new Error(`${name}: expected exactly one native shell`)
  const selected = new Set([...(config.coreTools ?? ['read', 'edit', 'write', 'grep', 'glob']), ...shells])
  return assembled.tools.filter(tool => selected.has(tool.name))
}

async function prefetch(context, config) {
  const cwd = context.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error(`${name}: missing session cwd`)
  const requested = String(config.prefetchPath ?? 'ONBOARDING_TODO.md')
  const root = resolve(cwd)
  const file = resolve(root, requested)
  const inside = relative(root, file)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${name}: invalid prefetch path`)
  return { requested, text: await readFile(file, 'utf8') }
}

export function apply(ctx, config = {}) {
  const disposers = []
  try {
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const events = context.agent?.session?.events
      const prefix = String(config.singleRequestSessionPrefix ?? '')
      if (prefix && String(context.agent?.session?.id ?? '').startsWith(prefix) && events?.some?.(event => event.type === 'tool/call')) {
        throw new Error('V6_SINGLE_REQUEST_STOP')
      }
      const [assembled, evidence] = await Promise.all([next(), prefetch(context, config)])
      return {
        ...assembled,
        sections: [
          { name: 'dsv4-v6-persona', text: String(config.persona ?? 'You are a helpful software engineer assistant.') },
          { name: 'dsv4-v6-prefetch', text: `Prefetched workspace evidence from ${evidence.requested}:\n\n${evidence.text}` },
        ],
        contexts: [],
        tools: selectedTools(assembled, config),
      }
    }))
    disposers.push(ctx.tools.guard(guardDecision))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
