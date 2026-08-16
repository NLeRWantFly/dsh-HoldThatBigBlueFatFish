export const name = 'dsv4-pro-contract-anchor-tools'
export const inject = ['systemPrompt']

export const MINIMAL_SYSTEM = 'You are a helpful software engineer assistant.'
export const CONTRACT_SYSTEM = 'Security, migration, API/protocol, and release constraints are invariants. Use verified slices. Preserve legacy rows; backfill replacement fields before indexing. Never rename/remove existing identifiers, even static/private; if logic moves, leave exact-name wrappers. Keep protocol strings and dependency/API names literal. Use clean build roots; never replace integrations for toolchain failures. Complete requested reports before docs; skip optional docs. Stop after required checks pass.'

export function hasDurableToolCall(events) {
  return Array.isArray(events) && events.some(event => event?.type === 'tool/call')
}

export function bootstrapToolNames(tools, shellTools = ['bash', 'pwsh'], commonTools = ['read']) {
  const available = new Set(tools.map(tool => tool.name))
  const shells = shellTools.filter(tool => available.has(tool))
  const missing = commonTools.filter(tool => !available.has(tool))
  if (shells.length !== 1 || missing.length > 0) {
    throw new Error(`${name}: expected one native shell and every common tool; shells=${JSON.stringify(shells)}, missing=${JSON.stringify(missing)}`)
  }
  return new Set([...commonTools, ...shells])
}

export function phaseSystem(events, config = {}) {
  const minimal = config.minimalSystem ?? MINIMAL_SYSTEM
  if (!hasDurableToolCall(events)) return minimal
  return `${minimal}\n\n${config.contractSystem ?? CONTRACT_SYSTEM}`
}

export function projectRequest(assembled, events, config = {}) {
  if (!hasDurableToolCall(events)) {
    const selected = bootstrapToolNames(
      assembled.tools,
      config.shellTools ?? ['bash', 'pwsh'],
      config.commonTools ?? ['read'],
    )
    return { ...assembled, tools: assembled.tools.filter(tool => selected.has(tool.name)) }
  }

  return assembled
}

export function apply(ctx, config = {}) {
  const disposePersona = ctx.systemPrompt.section({
    name: 'dsv4-pro:phase-persona',
    order: 1,
    complete: true,
    text: context => phaseSystem(context.agent?.session?.events, config),
  })
  const disposeAssembly = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const events = context.agent?.session?.events
    if (events === undefined) return assembled
    return projectRequest(assembled, events, config)
  })
  return () => {
    disposeAssembly()
    disposePersona()
  }
}
