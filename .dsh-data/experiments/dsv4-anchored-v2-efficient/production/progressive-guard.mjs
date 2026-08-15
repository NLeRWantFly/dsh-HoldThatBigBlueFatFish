import { PRO_PERSONA, applyModelPersona } from './model-policy.mjs'

export const name = 'dsv4-progressive-guard'
export const inject = ['systemPrompt', 'tools']

export const PERSONA = PRO_PERSONA

export const FIRST_STEP_BUDGET = 'PROGRESSIVE_FIRST_STEP_BUDGET: use at most two bounded calls in the first step.'
export const INVENTORY_BLOCKED = 'PROGRESSIVE_INVENTORY_BLOCKED: inspect at most 50 immediate entries or use one known path.'
export const INTERNAL_CONTEXT_BLOCKED = 'PROGRESSIVE_INTERNAL_CONTEXT_BLOCKED: inspect the workspace, not DSH internals or compressed session data.'
export const BOOTSTRAP_WRITE_BLOCKED = 'PROGRESSIVE_BOOTSTRAP_WRITE_BLOCKED: obtain one successful bounded read, shallow probe, or check before modifying files.'
export const SHELL_CONTENT_WRITE_BLOCKED = 'PROGRESSIVE_SHELL_CONTENT_WRITE_BLOCKED: use write or edit so mutation size can be bounded.'
export const MUTATION_TOO_LARGE = 'PROGRESSIVE_MUTATION_TOO_LARGE: keep this file mutation within the configured vertical-slice limit.'
export const SLICE_BUDGET = 'PROGRESSIVE_SLICE_BUDGET: run one relevant check before making another implementation slice.'
export const STOP_AFTER_CHECK = 'PROGRESSIVE_STOP_AFTER_CHECK: the relevant check passed; make one directly justified fix or answer now.'
export const REPEAT_BLOCKED = 'PROGRESSIVE_REPEAT_BLOCKED: change the code or choose a different diagnostic before repeating this command.'

const BOOTSTRAP_SHELL_DESCRIPTION = 'Run one foreground, bounded workspace probe or check. For an empty project, list at most 50 immediate entries. Prefer read for known files. Do not inspect harness internals or compressed session logs.'

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

const SHELL_CONTENT_WRITE = [
  /\b(?:set-content|add-content|out-file|clear-content)\b/i,
  /(?:^|[;&|]\s*)tee(?:\s|$)/i,
  /\b(?:sed\s+-[A-Za-z]*i|perl\s+-[A-Za-z]*pi)\b/i,
  /(^|[^>])>>?(?![=&])/,
  /(?:^|\s)(?:@['\"]|<<[-~]?\s*['\"]?\w+)/,
]

const CHECK_SHELL = [
  /\b(?:pytest|ctest|cargo\s+test|go\s+test|dotnet\s+test|node\s+--test)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|build|typecheck))\b/i,
  /\bpython(?:\.exe)?\s+(?:-m\s+(?:pytest|unittest)|[^\r\n;&|]*(?:test|check|probe|build)[^\r\n;&|]*\.py)\b/i,
  /\bnode(?:\.exe)?\s+(?:--check\s+[^\r\n;&|]+|[^\r\n;&|]*(?:test|check|probe)[^\r\n;&|]*\.(?:c?js|mjs|ts))\b/i,
  /\b(?:tsc\s+--noEmit|eslint|ruff\s+check|mypy|shellcheck|bash\s+-n)\b/i,
]

const RESULT_FAILURE = [
  /\[exit code:\s*(?!0\])(?:-?\d+|null)\]/i,
  /\[(?:timed out|timeout|aborted|sandbox:[^\]]*denied)[^\]]*\]/i,
  /(?:^|\r?\n)\s*(?:FAIL(?:ED)?|ERROR|FATAL)(?::|\b)/im,
  /\b(?:ReferenceError|SyntaxError|AssertionError|UnhandledPromiseRejection|Traceback \(most recent call last\)|npm ERR!|ELIFECYCLE|command not found|is not recognized as)\b/i,
  /(?:^|\r?\n)\s*(?:CategoryInfo|FullyQualifiedErrorId)\s*:/im,
  /(?:^|\r?\n)[^\r\n:]+\s*:\s*(?:Cannot find|Access (?:is )?denied|Permission denied)/im,
]

const INTERNAL_CONTEXT = [
  /\$env:DSH_[A-Z0-9_]+/i,
  /\bEnv:DSH_[A-Z0-9_*?]+/i,
  /\bDSH_SESSION_JSONL\b/i,
  /\b(?:get-childitem|gci)\s+Env:/i,
  /(?:^|[\\/])(?:session[^\\/]*\.jsonl)(?:\.(?:zst|zstd|gz|zip))?(?:$|[\s'\"])/i,
]

const INTERNAL_OR_BINARY_PATH = /(?:^|[\\/])(?:DSH_SESSION_JSONL|session[^\\/]*\.jsonl(?:\.(?:zst|zstd|gz|zip))?|objects[\\/][0-9a-f]{2}[\\/][0-9a-f]+)$/i

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

function blockArguments(block) {
  return parseArguments(block?.arguments ?? block?.input ?? block?.args)
}

function resultBlock(event) {
  return event?.data?.message?.content?.find?.(block => block?.type === 'tool-result')
}

function collectText(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const entry of value) collectText(entry, output)
  else if (object(value)) {
    if (value.type === 'text' && typeof value.text === 'string') output.push(value.text)
    else for (const entry of Object.values(value)) collectText(entry, output)
  }
  return output
}

export function resultText(event) {
  return collectText(resultBlock(event)?.content).join('\n')
}

export function successfulResult(event) {
  const block = resultBlock(event)
  if (block === undefined || block.isError === true) return false
  const text = resultText(event)
  if (/PROGRESSIVE_[A-Z_]+:/.test(text)) return false
  return !RESULT_FAILURE.some(pattern => pattern.test(text))
}

function readablePath(path) {
  const normalized = String(path ?? '').trim().replaceAll('\\', '/')
  if (!normalized || /(?:^|\/)\.git\/objects(?:\/|$)/i.test(normalized)) return false
  return !INTERNAL_OR_BINARY_PATH.test(normalized.replaceAll('/', '\\'))
    && !/\.(?:zst|zstd|gz|zip|7z|rar|exe|dll|png|jpe?g|gif|webp|pdf)$/i.test(normalized)
}

function internalContextCommand(command) {
  return INTERNAL_CONTEXT.some(pattern => pattern.test(command))
}

function cappedCount(command, pattern, cap) {
  const match = command.match(pattern)
  if (match === null) return false
  const count = Number.parseInt(match[1], 10)
  return Number.isInteger(count) && count > 0 && count <= cap
}

export function boundedShallowProbe(tool, command, maxEntries = 50) {
  const value = String(command ?? '').trim()
  if (!value || /[\r\n;&]|\|\|/.test(value) || internalContextCommand(value)) return false
  if (tool === 'pwsh') {
    return /^(?:get-childitem|gci)\b/i.test(value)
      && !/\b(?:-recurse|-depth\s+[1-9]\d*)\b/i.test(value)
      && cappedCount(value, /\bselect-object\b[^\r\n;&]*\s-first\s+(\d+)\b/i, maxEntries)
  }
  if (tool !== 'bash') return false
  const capped = cappedCount(value, /\|\s*head\s+(?:-n\s+|-)(\d+)\b/i, maxEntries)
  if (!capped) return false
  return /^(?:command\s+)?ls\b/i.test(value)
    || (/^(?:command\s+)?find\s+\./i.test(value) && /\s-maxdepth\s+1\b/.test(value))
}

function broadShellCommand(tool, command, maxEntries) {
  if (boundedShallowProbe(tool, command, maxEntries)) return false
  const listing = tool === 'pwsh'
    ? /(?:^|[;&|]\s*)(?:get-childitem|gci)\b/i.test(command)
    : tool === 'bash' && /(?:^|[;&|]\s*)(?:find|ls)\b/.test(command)
  return listing || BROAD_SHELL.some(pattern => pattern.test(command))
}

function shellCheck(command) {
  return !BOOTSTRAP_MUTATION.some(pattern => pattern.test(command))
    && CHECK_SHELL.some(pattern => pattern.test(command))
}

function qualifiedCallKind(event, config = {}) {
  if (event?.type !== 'tool/call') return undefined
  const tool = String(event.data?.name ?? '')
  const args = callArguments(event)
  if (tool === 'read') return readablePath(args.file_path) ? 'read' : undefined
  if (tool !== 'bash' && tool !== 'pwsh') return undefined
  const command = String(args.command ?? '')
  if (internalContextCommand(command)
    || broadShellCommand(tool, command, config.bootstrapMaxEntries ?? 50)
    || BOOTSTRAP_MUTATION.some(pattern => pattern.test(command))) return undefined
  if (boundedShallowProbe(tool, command, config.bootstrapMaxEntries ?? 50)) return 'probe'
  return shellCheck(command) ? 'check' : undefined
}

function pairedResults(events) {
  const calls = new Map()
  const pairs = []
  for (let index = 0; index < (events?.length ?? 0); index++) {
    const event = events[index]
    if (event?.type === 'tool/call') calls.set(event.data?.callId, { event, index })
    if (event?.type !== 'tool/result') continue
    const block = resultBlock(event)
    const callId = block?.toolCallId ?? event.data?.callId
    const found = calls.get(callId)
    if (found !== undefined) pairs.push({ call: found.event, callIndex: found.index, result: event, resultIndex: index })
  }
  return pairs
}

export function hasQualifiedEvidence(events, config = {}) {
  return pairedResults(events).some(pair => successfulResult(pair.result) && qualifiedCallKind(pair.call, config) !== undefined)
}

export function isPlanMode(events) {
  let active = false
  for (const event of events ?? []) {
    if (event?.type === 'plan/mode' && typeof event.data?.active === 'boolean') active = event.data.active
  }
  return active
}

function rawProperties(parameters) {
  return object(parameters?.properties) ? parameters.properties : undefined
}

function projectParameters(parameters, allowed) {
  const properties = rawProperties(parameters)
  if (properties !== undefined) {
    const projected = Object.fromEntries(allowed.filter(key => properties[key] !== undefined).map(key => [key, properties[key]]))
    const required = Array.isArray(parameters.required) ? parameters.required.filter(key => allowed.includes(key)) : undefined
    return {
      ...parameters,
      properties: projected,
      additionalProperties: false,
      ...(required === undefined ? {} : { required }),
    }
  }
  if (!object(parameters)) return parameters
  return Object.fromEntries(allowed.filter(key => parameters[key] !== undefined).map(key => [key, parameters[key]]))
}

function projectBootstrapShell(tool) {
  return {
    ...tool,
    description: BOOTSTRAP_SHELL_DESCRIPTION,
    parameters: projectParameters(tool.parameters, ['command', 'description', 'timeoutMs', 'workdir']),
  }
}

function withStringLimit(schema, maxLength) {
  return object(schema)
    ? { ...schema, maxLength, description: `${schema.description ?? 'Text value.'} Maximum ${maxLength} characters per call.` }
    : schema
}

function projectMutationTool(tool, maxLength) {
  if (tool.name !== 'write' && tool.name !== 'edit') return tool
  const parameters = tool.parameters
  const properties = rawProperties(parameters)
  if (properties !== undefined) {
    const limited = tool.name === 'write'
      ? { content: withStringLimit(properties.content, maxLength) }
      : {
          old_string: withStringLimit(properties.old_string, maxLength),
          new_string: withStringLimit(properties.new_string, maxLength),
        }
    return {
      ...tool,
      description: `${tool.description} One call is limited to ${maxLength} generated characters; build in tested vertical slices.`,
      parameters: { ...parameters, properties: { ...properties, ...limited } },
    }
  }
  if (!object(parameters)) return tool
  const limited = tool.name === 'write'
    ? { content: withStringLimit(parameters.content, maxLength) }
    : {
        old_string: withStringLimit(parameters.old_string, maxLength),
        new_string: withStringLimit(parameters.new_string, maxLength),
      }
  return {
    ...tool,
    description: `${tool.description} One call is limited to ${maxLength} generated characters; build in tested vertical slices.`,
    parameters: { ...parameters, ...limited },
  }
}

export function filterCatalog(assembled, events, config = {}) {
  if (isPlanMode(events)) return assembled
  const available = new Set(assembled.tools.map(tool => tool.name))
  const shells = (config.shellTools ?? ['bash', 'pwsh']).filter(tool => available.has(tool))
  if (shells.length !== 1) throw new Error(`${name}: expected one native shell, got ${shells.join(',')}`)
  const promoted = hasQualifiedEvidence(events, config)
  const requested = promoted
    ? (config.coreTools ?? ['read', 'edit', 'write', 'grep', 'glob'])
    : (config.bootstrapTools ?? ['read'])
  const selected = new Set([...requested, ...shells])
  const missing = [...selected].filter(tool => !available.has(tool))
  if (missing.length > 0) throw new Error(`${name}: missing tools ${missing.join(',')}`)
  const maxLength = Number.isInteger(config.maxMutationChars) ? config.maxMutationChars : 12_000
  return {
    ...assembled,
    tools: assembled.tools
      .filter(tool => selected.has(tool.name))
      .map(tool => promoted
        ? projectMutationTool(tool, maxLength)
        : (shells.includes(tool.name) ? projectBootstrapShell(tool) : tool)),
  }
}

export function shapeAssembly(assembled, events, modelId, config = {}) {
  const withPersona = {
    ...assembled,
    sections: applyModelPersona(assembled.sections, modelId),
  }
  return Array.isArray(events) ? filterCatalog(withPersona, events, config) : withPersona
}

function assistantCallContext(events, callId) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const calls = event.data?.message?.content?.filter?.(block => block?.type === 'tool-call') ?? []
    const callIndex = calls.findIndex(block => block.id === callId)
    if (callIndex >= 0) return { callIndex, calls, eventIndex: index, step: event.data?.step }
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

function shellContentWrite(name, args) {
  return (name === 'bash' || name === 'pwsh')
    && SHELL_CONTENT_WRITE.some(pattern => pattern.test(String(args?.command ?? '')))
}

function mutationCall(name, args) {
  return name === 'write' || name === 'edit' || shellContentWrite(name, args)
}

function mutationSize(name, args) {
  if (name === 'write') return String(args?.content ?? '').length
  if (name === 'edit') return String(args?.old_string ?? '').length + String(args?.new_string ?? '').length
  return shellContentWrite(name, args) ? String(args?.command ?? '').length : 0
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

function latestCheckPair(events) {
  return pairedResults(events).filter(pair => qualifiedCallKind(pair.call) === 'check').at(-1)
}

function successfulMutationCharsSinceCheck(events) {
  const pairs = pairedResults(events)
  const lastCheck = pairs.filter(pair => successfulResult(pair.result) && qualifiedCallKind(pair.call) === 'check').at(-1)
  const start = lastCheck?.resultIndex ?? -1
  return pairs
    .filter(pair => pair.resultIndex > start && successfulResult(pair.result))
    .reduce((total, pair) => {
      const tool = String(pair.call.data?.name ?? '')
      const args = callArguments(pair.call)
      return total + (mutationCall(tool, args) ? mutationSize(tool, args) : 0)
    }, 0)
}

function priorBatchCalls(context) {
  return context === undefined ? [] : context.calls.slice(0, context.callIndex)
}

function priorBatchMutationStats(context) {
  return priorBatchCalls(context).reduce((stats, block) => {
    const args = blockArguments(block)
    const tool = String(block.name ?? '')
    if (!mutationCall(tool, args)) return stats
    return { calls: stats.calls + 1, chars: stats.chars + mutationSize(tool, args) }
  }, { calls: 0, chars: 0 })
}

function postCheckAuditCount(events, context, latestCheck) {
  if (latestCheck === undefined || !successfulResult(latestCheck.result)) return 0
  const pairs = pairedResults(events)
  if (pairs.some(pair => pair.resultIndex > latestCheck.resultIndex
    && successfulResult(pair.result)
    && mutationCall(String(pair.call.data?.name ?? ''), callArguments(pair.call)))) return 0
  const historyEnd = context?.eventIndex ?? events.length
  const historical = events.slice(latestCheck.resultIndex + 1, historyEnd)
    .filter(event => event?.type === 'tool/call')
    .filter(event => !mutationCall(String(event.data?.name ?? ''), callArguments(event)))
    .length
  const batched = priorBatchCalls(context)
    .filter(block => !mutationCall(String(block.name ?? ''), blockArguments(block)))
    .length
  return historical + batched
}

export function shapeRequest(request, config = {}) {
  const max = Number.isInteger(config.requestMaxTokens) && config.requestMaxTokens > 0
    ? config.requestMaxTokens
    : undefined
  const current = Number.isInteger(request?.maxTokens) && request.maxTokens > 0 ? request.maxTokens : undefined
  return {
    ...request,
    ...(max === undefined ? {} : { maxTokens: current === undefined ? max : Math.min(current, max) }),
  }
}

export function guardDecision(exec, config = {}) {
  const events = exec?.agent?.session?.events
  if (!Array.isArray(events) || isPlanMode(events)) return undefined
  const context = assistantCallContext(events, exec.callId)
  const budget = Number.isInteger(config.maxFirstStepCalls) ? config.maxFirstStepCalls : 2
  if (context?.step === 1 && context.callIndex >= budget) return FIRST_STEP_BUDGET

  const tool = String(exec.name ?? '')
  const args = object(exec.arguments) ? exec.arguments : parseArguments(exec.arguments)
  const command = String(args.command ?? '')
  if (config.blockInternalContext !== false && (tool === 'bash' || tool === 'pwsh') && internalContextCommand(command)) {
    return INTERNAL_CONTEXT_BLOCKED
  }

  if (config.blockBroadInventory !== false) {
    if ((tool === 'bash' || tool === 'pwsh')
      && (args.run_in_background === true || broadShellCommand(tool, command, config.bootstrapMaxEntries ?? 50))) {
      return INVENTORY_BLOCKED
    }
    if (tool === 'glob' && broadGlob(args)) return INVENTORY_BLOCKED
    if (tool === 'grep' && broadGrep(args)) return INVENTORY_BLOCKED
  }

  const promoted = hasQualifiedEvidence(events, config)
  if (!promoted && config.blockBootstrapWrites !== false
    && (tool === 'bash' || tool === 'pwsh')
    && BOOTSTRAP_MUTATION.some(pattern => pattern.test(command))) return BOOTSTRAP_WRITE_BLOCKED
  if (!promoted && !['read', 'bash', 'pwsh'].includes(tool)) return BOOTSTRAP_WRITE_BLOCKED

  if (promoted && config.blockShellContentWrites !== false && shellContentWrite(tool, args)) {
    return SHELL_CONTENT_WRITE_BLOCKED
  }

  const mutation = mutationCall(tool, args)
  if (promoted && mutation) {
    const maxMutationChars = Number.isInteger(config.maxMutationChars) ? config.maxMutationChars : 12_000
    const maxUnverifiedChars = Number.isInteger(config.maxUnverifiedMutationChars) ? config.maxUnverifiedMutationChars : 24_000
    const maxMutations = Number.isInteger(config.maxMutationsPerStep) ? config.maxMutationsPerStep : 2
    const batch = priorBatchMutationStats(context)
    const size = mutationSize(tool, args)
    if (size > maxMutationChars) return MUTATION_TOO_LARGE
    if (batch.calls >= maxMutations) return SLICE_BUDGET
    if (successfulMutationCharsSinceCheck(events) + batch.chars + size > maxUnverifiedChars) return SLICE_BUDGET
  }

  if (promoted && !mutation) {
    const maxPostCheckCalls = Number.isInteger(config.maxPostCheckCalls) ? config.maxPostCheckCalls : 2
    if (postCheckAuditCount(events, context, latestCheckPair(events)) >= maxPostCheckCalls) return STOP_AFTER_CHECK
  }

  const repeatLimit = Number.isInteger(config.repeatLimit) ? config.repeatLimit : 2
  return promoted && repeatedShell(events, exec, repeatLimit) ? REPEAT_BLOCKED : undefined
}

export function apply(ctx, config = {}) {
  const disposers = []
  try {
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const events = context.agent?.session?.events
      return shapeAssembly(assembled, events, context.agent?.options?.model, config)
    }))
    disposers.push(ctx.on('agent/request', async ({ agent }, next) => {
      const request = await next()
      return isPlanMode(agent?.session?.events) ? request : shapeRequest(request, config)
    }))
    disposers.push(ctx.tools.guard(exec => guardDecision(exec, config)))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
