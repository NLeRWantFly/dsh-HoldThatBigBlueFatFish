export const name = 'dsv4-official-probe-stop'
export const inject = ['agents']

export function apply(ctx, config = {}) {
  const sessionPrefix = config.sessionPrefix ?? 'probe-dsv4-official-'
  const maximum = config.maxAssistantMessages ?? 3
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError(`${name}: maxAssistantMessages must be a positive integer`)

  return ctx.on('session/event', (session, event) => {
    if (!String(session.id).startsWith(sessionPrefix) || event.type !== 'assistant/message') return
    const count = session.events.filter(candidate => candidate.type === 'assistant/message').length
    if (count >= maximum) ctx.agents.get(session.id)?.cancel({ kind: 'user' })
  })
}
