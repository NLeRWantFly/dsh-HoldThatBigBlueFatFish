export const name = 'dsv4-progressive-guard'
export const inject = ['systemPrompt', 'tools']

export const FIRST_STEP_BUDGET = 'PROGRESSIVE_FIRST_STEP_BUDGET: use at most two bounded calls in the first step.'
export const INVENTORY_BLOCKED = 'PROGRESSIVE_INVENTORY_BLOCKED: use one known path, file pattern, or command instead of inventorying the workspace.'
export const BOOTSTRAP_WRITE_BLOCKED = 'PROGRESSIVE_BOOTSTRAP_WRITE_BLOCKED: obtain one successful bounded read or diagnostic result before modifying files.'
export const REPEAT_BLOCKED = 'PROGRESSIVE_REPEAT_BLOCKED: change the code or choose a different diagnostic before repeating this command.'

const BROAD_SHELL = [
  /\b(?:get-childitem|gci)\b[^\r\n;&|]*-recurse\b/i,
  /(?:^|[;&|]\s*)(?:get-childitem|gci)(?:\s+-(?:force|file|directory))*\s*(?=\||[;&]|$)/i,
  /\bdir(?:\.exe)?\s+\/s(?:\s|$)/i,
  /(?:^|[;&|]\s*)dir(?:\.exe)?(?:\s+\/[abdw-]+)*\s*(?=[;&|]|$)/i,
  /(?:^|[;&|]\s*)tree(?:\.com|\.exe)?(?:\s|$)/i,
  /\brg(?:\.exe)?\b[^\r\n;&|]*\s--files\b/i,
  /\bgit\s+ls-files\b/i,
  /(?:^|[;&|]\s*)find(?:\.exe)?\s+\.(?:[\\/\s]|$)/i,
  /(?:^|[;&|]\s*)ls(?:\s+-[A-Za-z]+)?\s*(?=[;&|]|$)/,
]

const BOOTSTRAP_MUTATION = [
  /\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content)\b/i,
  /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|chmod|chown|tee)(?:\s|$)/i,
  /\b(?:sed\s+-[A-Za-z]*i|perl\s+-[A-Za-z]*pi)\b/i,
  /(^|[^>])>>?(?![=&])/,
]

const QUALIFIED_SHELL = [
  /\b(?:get-content|type|more|head|tail|sed)\b/i,
  /\b(?:pytest|ctest|cargo\s+test|go\s+test|dotnet\s+test|node\s+--test|npm\s+test|pnpm\s+test)\b/i,
  /\bpython(?:\.exe)?\s+[^\r\n;&|]*(?:run_public_tests|run_debug_probe|run_espidf_build)\.py\b/i,
  /\b(?:rg|grep|select-string)\b[^\r\n;&|]*(?:reference|tests|tools|project2_task|[\\/])/i,
]

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArguments(value) {
  if (object(value)) return value
  if (typeof value !== 'string') return {}
  try { return JSON.parse(value) } catch { return { raw: value } }
}

function callArguments(event) {
  return parseArguments(event?.data?.arguments ?? event?.data?.input ?? event?.data?.args)
}

function resultBlock(event) {
  return event?.data?.message?.content?.find?.(block => block?.type === 'tool-result')
}

function successfulResult(event) {
  const block = resultBlock(event)
  return block !== undefined
    && block.isError !== true
    && !/PROGRESSIVE_[A-Z_]+:/.test(JSON.stringify(block.content ?? ''))
}

function qualifiedCall(event) {
  if (event?.type !== 'tool/call') return false
  const tool = String(event.data?.name ?? '')
  const args = callArguments(event)
  if (tool === 'read') return typeof args.file_path === 'string' && args.file_path.trim() !== ''
  if (tool !== 'bash' && tool !== 'pwsh') return false
  const command = String(args.command ?? '')
  return !BROAD_SHELL.some(pattern => pattern.test(command))
    && !BOOTSTRAP_MUTATION.some(pattern => pattern.test(command))
    && QUALIFIED_SHELL.some(pattern => pattern.test(command))
}

export function hasQualifiedEvidence(events) {
  const calls = new Map()
  for (const event of events ?? []) {
    if (event?.type === 'tool/call') calls.set(event.data?.callId, event)
    if (event?.type !== 'tool/result' || !successfulResult(event)) continue
    const block = resultBlock(event)
    const callId = block?.toolCallId ?? event.data?.callId
    if (qualifiedCall(calls.get(callId))) return true
  }
  return false
}

export function isPlanMode(events) {
  let active = false
  for (const event of events ?? []) {
    if (event?.type === 'plan/mode' && typeof event.data?.active === 'boolean') active = event.data.active
  }
  return active
}

export function filterCatalog(assembled, events, config = {}) {
  if (isPlanMode(events)) return assembled
  const available = new Set(assembled.tools.map(tool => tool.name))
  const shells = (config.shellTools ?? ['bash', 'pwsh']).filter(tool => available.has(tool))
  if (shells.length !== 1) throw new Error(`${name}: expected one native shell, got ${shells.join(',')}`)
  const requested = hasQualifiedEvidence(events)
    ? (config.coreTools ?? ['read', 'edit', 'write', 'grep', 'glob'])
    : (config.bootstrapTools ?? ['read'])
  const selected = new Set([...requested, ...shells])
  const missing = [...selected].filter(tool => !available.has(tool))
  if (missing.length > 0) throw new Error(`${name}: missing tools ${missing.join(',')}`)
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

function broadGlob(args) {
  const pattern = String(args?.pattern ?? '').trim().replaceAll('\\', '/')
  if (!pattern) return true
  return pattern === '*' || pattern === '**' || pattern === '**/*'
    || /(?:^|\/)\*\*\/\*(?:$|\/)/.test(pattern)
}

function broadGrep(args) {
  const path = String(args?.path ?? args?.file_path ?? '').trim().replaceAll('\\', '/')
  return !path || path === '.' || path === './'
}

function repeatedShell(events, exec, limit) {
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
  return repeats >= limit
}

export function guardDecision(exec, config = {}) {
  const events = exec?.agent?.session?.events
  if (!Array.isArray(events)) return undefined
  if (isPlanMode(events)) return undefined
  const context = assistantCallContext(events, exec.callId)
  const budget = Number.isInteger(config.maxFirstStepCalls) ? config.maxFirstStepCalls : 2
  if (context?.step === 1 && context.callIndex >= budget) return FIRST_STEP_BUDGET

  if (config.blockBroadInventory !== false) {
    if ((exec.name === 'bash' || exec.name === 'pwsh')
      && (exec.arguments?.run_in_background === true || BROAD_SHELL.some(pattern => pattern.test(String(exec.arguments?.command ?? ''))))) {
      return INVENTORY_BLOCKED
    }
    if (exec.name === 'glob' && broadGlob(exec.arguments)) return INVENTORY_BLOCKED
    if (exec.name === 'grep' && broadGrep(exec.arguments)) return INVENTORY_BLOCKED
  }

  const promoted = hasQualifiedEvidence(events)
  if (!promoted && config.blockBootstrapWrites !== false
    && (exec.name === 'bash' || exec.name === 'pwsh')
    && BOOTSTRAP_MUTATION.some(pattern => pattern.test(String(exec.arguments?.command ?? '')))) {
    return BOOTSTRAP_WRITE_BLOCKED
  }
  if (!promoted && !['read', 'bash', 'pwsh'].includes(String(exec.name))) return BOOTSTRAP_WRITE_BLOCKED

  const repeatLimit = Number.isInteger(config.repeatLimit) ? config.repeatLimit : 2
  return promoted && repeatedShell(events, exec, repeatLimit) ? REPEAT_BLOCKED : undefined
}

export function apply(ctx, config = {}) {
  const disposers = []
  try {
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const events = context.agent?.session?.events
      return Array.isArray(events) ? filterCatalog(assembled, events, config) : assembled
    }))
    disposers.push(ctx.tools.guard(exec => guardDecision(exec, config)))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
