export const name = 'dsv4-official-v2-probe-stop'
export const inject = ['agents']

export function apply(ctx, config = {}) {
  const prefix = config.sessionPrefix ?? 'probe-dsv4-v2-'
  const maximum = config.maxAssistantMessages ?? 3
  return ctx.on('session/event', (session, event) => {
    if (!String(session.id).startsWith(prefix) || event.type !== 'assistant/message') return
    const count = session.events.filter(candidate => candidate.type === 'assistant/message').length
    if (count >= maximum) ctx.agents.get(session.id)?.cancel({ kind: 'user' })
  })
}
