export const name = 'dsv4-official-v2-policy'
export const inject = ['systemPrompt', 'tools']

export const BOOTSTRAP_BUDGET_DENIAL = 'V2_BOOTSTRAP_BUDGET: use at most two bounded calls before obtaining evidence.'
export const BOOTSTRAP_SCOPE_DENIAL = 'V2_BOOTSTRAP_SCOPE: use one named path or command; recursive inventory and background work are unavailable.'
export const REPEAT_DENIAL = 'V2_NO_PROGRESS_REPEAT: choose a different check or make a code change before repeating this command.'

const BROAD_SHELL = [
  /\b(?:get-childitem|gci)\b[^\r\n;&|]*-recurse\b/i,
  /\bdir(?:\.exe)?\s+\/s(?:\s|$)/i,
  /(?:^|[;&|]\s*)tree(?:\.com|\.exe)?(?:\s|$)/i,
  /\brg(?:\.exe)?\b[^\r\n;&|]*\s--files\b/i,
  /\bgit\s+ls-files\b/i,
  /(?:^|[;&|]\s*)find(?:\.exe)?\s+\.(?:[\\/\s]|$)/i,
  /(?:^|[;&|]\s*)ls\s+-[A-Za-z]*R[A-Za-z]*(?:\s|$)/,
]

const QUALIFIED_SHELL = [
  /\b(?:get-content|type|more|head|tail|sed)\b/i,
  /\b(?:pytest|ctest|cargo\s+test|go\s+test|dotnet\s+test|node\s+--test|npm\s+test|pnpm\s+test)\b/i,
  /\bpython(?:\.exe)?\s+[^\r\n;&|]*(?:run_public_tests|run_debug_probe|run_espidf_build)\.py\b/i,
  /\b(?:rg|grep|select-string)\b[^\r\n;&|]*(?:reference|tests|tools|project2_task|[\\/])/i,
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
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return undefined
  return content.find(block => block?.type === 'tool-result')
}

function resultText(block) {
  return JSON.stringify(block?.content ?? '')
}

export function successfulResult(event) {
  const block = resultBlock(event)
  return block !== undefined
    && block.isError !== true
    && !/V2_(?:BOOTSTRAP|NO_PROGRESS)/.test(resultText(block))
}

export function qualifiedCall(event) {
  if (event?.type !== 'tool/call') return false
  const tool = String(event.data?.name ?? '')
  const args = callArguments(event)
  if (tool === 'read') return typeof args.file_path === 'string' && args.file_path.trim() !== ''
  if (tool !== 'bash' && tool !== 'pwsh') return false
  const command = String(args.command ?? '')
  return !BROAD_SHELL.some(pattern => pattern.test(command))
    && QUALIFIED_SHELL.some(pattern => pattern.test(command))
}

export function hasQualifiedEvidence(events) {
  if (!Array.isArray(events)) return false
  const calls = new Map()
  for (const event of events) {
    if (event?.type === 'tool/call') calls.set(event.data?.callId, event)
    if (event?.type !== 'tool/result' || !successfulResult(event)) continue
    const callId = resultBlock(event)?.toolCallId ?? event.data?.callId
    if (qualifiedCall(calls.get(callId))) return true
  }
  return false
}

function selectCatalog(tools, names, shellTools = ['bash', 'pwsh']) {
  const available = new Set(tools.map(tool => tool.name))
  const shells = shellTools.filter(tool => available.has(tool))
  if (shells.length !== 1) throw new Error(`${name}: expected one native shell, got ${shells.join(',')}`)
  const selected = new Set([...names, ...shells])
  const missing = [...selected].filter(tool => !available.has(tool))
  if (missing.length > 0) throw new Error(`${name}: missing tools ${missing.join(',')}`)
  return selected
}

export function filterCatalog(assembled, events, config = {}) {
  const promoted = hasQualifiedEvidence(events)
  const names = promoted
    ? (config.coreTools ?? ['read', 'edit', 'write', 'grep', 'glob'])
    : (config.bootstrapTools ?? ['read'])
  const selected = selectCatalog(assembled.tools, names, config.shellTools ?? ['bash', 'pwsh'])
  return { ...assembled, tools: assembled.tools.filter(tool => selected.has(tool.name)) }
}

function assistantCallContext(events, callId) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const calls = content.filter(block => block?.type === 'tool-call')
    const callIndex = calls.findIndex(block => block.id === callId)
    if (callIndex >= 0) return { callIndex, step: event.data?.step, turn: event.data?.turn }
  }
  return undefined
}

function broadShell(args) {
  if (!record(args)) return false
  if (args.run_in_background === true) return true
  const command = String(args.command ?? '')
  return BROAD_SHELL.some(pattern => pattern.test(command))
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
  const promoted = hasQualifiedEvidence(events)
  if ((exec.name === 'bash' || exec.name === 'pwsh') && exec.arguments?.run_in_background === true) {
    return BOOTSTRAP_SCOPE_DENIAL
  }
  if (promoted) return repeatedShell(events, exec) ? REPEAT_DENIAL : undefined
  const context = assistantCallContext(events, exec.callId)
  if (context?.step === 1 && context.callIndex >= 2) return BOOTSTRAP_BUDGET_DENIAL
  if ((exec.name === 'bash' || exec.name === 'pwsh') && broadShell(exec.arguments)) return BOOTSTRAP_SCOPE_DENIAL
  if (!['read', 'bash', 'pwsh'].includes(String(exec.name))) return BOOTSTRAP_SCOPE_DENIAL
  return undefined
}

export function apply(ctx, config = {}) {
  const disposers = []
  try {
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const events = context.agent?.session?.events
      return Array.isArray(events) ? filterCatalog(assembled, events, config) : assembled
    }))
    disposers.push(ctx.tools.guard(guardDecision))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
