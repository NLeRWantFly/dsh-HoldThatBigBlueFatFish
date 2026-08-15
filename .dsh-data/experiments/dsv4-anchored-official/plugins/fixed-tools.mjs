import { bootstrapToolNames } from './anchored-tools.mjs'

export const name = 'dsv4-official-fixed-tools'
export const inject = ['systemPrompt']

export function filterEveryRequest(assembled, config = {}) {
  const selected = bootstrapToolNames(
    assembled.tools,
    config.shellTools ?? ['bash', 'pwsh'],
    config.commonTools ?? ['read'],
  )
  return { ...assembled, tools: assembled.tools.filter(tool => selected.has(tool.name)) }
}

export function apply(ctx, config = {}) {
  return ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    return filterEveryRequest(await next(), config)
  })
}
