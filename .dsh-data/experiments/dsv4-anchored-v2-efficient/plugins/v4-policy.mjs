export const name = 'dsv4-official-v4-policy'
export const inject = ['systemPrompt', 'tools']

export const BOOTSTRAP_BUDGET_DENIAL = 'V4_BOOTSTRAP_BUDGET: only one initial read is available.'
export const BOOTSTRAP_SCOPE_DENIAL = 'V4_BOOTSTRAP_SCOPE: read one file path explicitly named by the user.'
export const INVENTORY_DENIAL = 'V4_INVENTORY: recursive directory inventory and background work are unavailable.'
export const REPEAT_DENIAL = 'V4_NO_PROGRESS_REPEAT: choose a different check or make a code change before repeating this command.'

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

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArguments(value) {
  if (record(value)) return value
  if (typeof value !== 'string') return {}
  try { return JSON.parse(value) } catch { return { raw: value } }
}

function callArguments(event) {
  return parseArguments(event?.data?.arguments ?? event?.data?.input ?? event?.data?.args)
}

function resultBlock(event) {
  return event?.data?.message?.content?.find?.(block => block?.type === 'tool-result')
}

function normalizePath(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()
}

function latestUserText(events) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    return (event.data?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
  }
  return ''
}

export function userNamedPath(events, filePath) {
  const path = normalizePath(filePath)
  if (!path || path.includes('..')) return false
  const text = normalizePath(latestUserText(events))
  return text.includes(path)
}

function qualifiedInitialRead(event, events) {
  if (event?.type !== 'tool/call' || event.data?.name !== 'read') return false
  return userNamedPath(events, callArguments(event).file_path)
}

export function hasQualifiedEvidence(events) {
  const calls = new Map()
  for (const event of events ?? []) {
    if (event?.type === 'tool/call') calls.set(event.data?.callId, event)
    if (event?.type !== 'tool/result') continue
    const block = resultBlock(event)
    const text = JSON.stringify(block?.content ?? '')
    if (!block || block.isError === true || /V4_(?:BOOTSTRAP|INVENTORY|NO_PROGRESS)/.test(text)) continue
    const callId = block.toolCallId ?? event.data?.callId
    if (qualifiedInitialRead(calls.get(callId), events)) return true
  }
  return false
}

export function filterCatalog(assembled, events, config = {}) {
  if (!hasQualifiedEvidence(events)) {
    const read = assembled.tools.filter(tool => tool.name === 'read')
    if (read.length !== 1) throw new Error(`${name}: expected exactly one read tool`)
    return { ...assembled, tools: read }
  }
  const available = new Set(assembled.tools.map(tool => tool.name))
  const shells = (config.shellTools ?? ['bash', 'pwsh']).filter(tool => available.has(tool))
  if (shells.length !== 1) throw new Error(`${name}: expected exactly one native shell after promotion`)
  const selected = new Set([...(config.coreTools ?? ['read', 'edit', 'write', 'grep', 'glob']), ...shells])
  return { ...assembled, tools: assembled.tools.filter(tool => selected.has(tool.name)) }
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

function broadShell(args) {
  if (!record(args)) return false
  if (args.run_in_background === true) return true
  return BROAD_SHELL.some(pattern => pattern.test(String(args.command ?? '')))
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
    const previous = String(callArguments(event).command ?? '').trim().replace(/\s+/g, ' ')
    if (previous === command) repeats++
  }
  return repeats >= 2
}

export function guardDecision(exec) {
  const events = exec?.agent?.session?.events
  if (!Array.isArray(events)) return undefined
  if ((exec.name === 'bash' || exec.name === 'pwsh') && broadShell(exec.arguments)) return INVENTORY_DENIAL
  const context = assistantCallContext(events, exec.callId)
  if (context?.step === 1 && context.callIndex >= 1) return BOOTSTRAP_BUDGET_DENIAL
  if (hasQualifiedEvidence(events)) return repeatedShell(events, exec) ? REPEAT_DENIAL : undefined
  if (exec.name !== 'read') return BOOTSTRAP_SCOPE_DENIAL
  return userNamedPath(events, exec.arguments?.file_path) ? undefined : BOOTSTRAP_SCOPE_DENIAL
}

export function apply(ctx, config = {}) {
  const disposers = []
  try {
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const events = context.agent?.session?.events
      const prefix = String(config.singleRequestSessionPrefix ?? '')
      if (prefix && String(context.agent?.session?.id ?? '').startsWith(prefix) && events?.some?.(event => event.type === 'tool/call')) {
        throw new Error('V4_SINGLE_REQUEST_STOP')
      }
      const assembled = await next()
      return Array.isArray(events) ? filterCatalog(assembled, events, config) : assembled
    }))
    disposers.push(ctx.tools.guard(guardDecision))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
