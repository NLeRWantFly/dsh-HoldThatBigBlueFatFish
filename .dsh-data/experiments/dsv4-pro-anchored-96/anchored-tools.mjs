export const name = 'dsv4-pro-anchored-96-tools'
export const inject = ['systemPrompt']

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

export function filterFirstRequest(assembled, events, config = {}) {
  if (hasDurableToolCall(events)) return assembled
  const selected = bootstrapToolNames(
    assembled.tools,
    config.shellTools ?? ['bash', 'pwsh'],
    config.commonTools ?? ['read'],
  )
  return { ...assembled, tools: assembled.tools.filter(tool => selected.has(tool.name)) }
}

export function apply(ctx, config = {}) {
  return ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const events = context.agent?.session?.events
    if (events === undefined) return assembled
    return filterFirstRequest(assembled, events, config)
  })
}
