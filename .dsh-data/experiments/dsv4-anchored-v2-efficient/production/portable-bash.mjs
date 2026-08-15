export const name = 'dsv4-portable-bash'
export const inject = ['tools']

export const PORTABLE_BASH_REJECTED = 'PORTABLE_BASH_REJECTED: use one portable developer command, or use read/grep/glob for filesystem inspection.'

const DESCRIPTION = 'Run one Linux-style portable developer command through the existing sandboxed Windows shell. Use forward-slash paths and cross-platform CLIs such as git, rg, node, npm, pnpm, python, pytest, cargo, go, dotnet, cmake, or ctest. Use read/grep/glob instead of cat, sed, awk, or general find pipelines. POSIX scripts, shell variables, redirection, arbitrary pipes, and sandbox escalation are intentionally unsupported.'

const PORTABLE_PROGRAM = /^(?:git|rg|node|npm(?:\.cmd)?|npx(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun|python(?:3|\.exe)?|py|pytest|cargo|go|dotnet|cmake|ctest|make|pwd)\b/i
const PACKAGE_RUNNER = /^(npm|npx|pnpm|yarn)(?=\s|$)/i

function quotePwshLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function boundedProbe(command, maxEntries) {
  const find = command.match(/^find\s+(\.|(?:\.\/)?[^\s'"*?$|;&]+)\s+-maxdepth\s+1(?:\s+-mindepth\s+1)?\s+-print\s*\|\s*head\s+(?:-n\s+|-)(\d+)\s*$/i)
  const list = command.match(/^ls(?:\s+-[A-Za-z]+)?(?:\s+(\.|(?:\.\/)?[^\s'"*?$|;&]+))?\s*\|\s*head\s+(?:-n\s+|-)(\d+)\s*$/i)
  const match = find ?? list
  if (match === null) return undefined
  const count = Number.parseInt(match.at(-1), 10)
  if (!Number.isInteger(count) || count < 1 || count > maxEntries) throw new Error(PORTABLE_BASH_REJECTED)
  const path = find === null ? (match[1] ?? '.') : match[1]
  return `Get-ChildItem -LiteralPath ${quotePwshLiteral(path)} -Force | Select-Object -First ${count} Name,Mode,Length`
}

function splitChains(command) {
  const parts = []
  let quote
  let start = 0
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote !== undefined) {
      if (char === quote && command[index - 1] !== '\\') quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '&' && command[index + 1] === '&') {
      parts.push(command.slice(start, index).trim())
      start = index + 2
      index++
    }
  }
  if (quote !== undefined) throw new Error(PORTABLE_BASH_REJECTED)
  parts.push(command.slice(start).trim())
  return parts
}

function syntaxOutsideQuotes(command) {
  let output = ''
  let quote
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote !== undefined) {
      if (char === quote && command[index - 1] !== '\\') quote = undefined
      else output += ' '
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      output += ' '
    } else output += char
  }
  return output
}

function portableSegment(segment) {
  if (!segment || !PORTABLE_PROGRAM.test(segment)) throw new Error(PORTABLE_BASH_REJECTED)
  if (/^(?:cat|sed|awk|grep|find|head|tail|curl|wget|bash|sh)\b/i.test(segment)) {
    throw new Error(PORTABLE_BASH_REJECTED)
  }
  if (/^pwd\s*$/i.test(segment)) return '(Get-Location).Path'
  return segment.replace(PACKAGE_RUNNER, runner => process.platform === 'win32' ? `${runner}.cmd` : runner)
}

export function translatePortableBash(command, config = {}) {
  const value = String(command ?? '').trim()
  const maxEntries = Number.isInteger(config.maxProbeEntries) ? config.maxProbeEntries : 50
  if (!value || /[\r\n`$]/.test(value) || /\|\||(?<!&)\&(?!&)/.test(value)) {
    throw new Error(PORTABLE_BASH_REJECTED)
  }
  const probe = boundedProbe(value, maxEntries)
  if (probe !== undefined) return probe
  const outside = syntaxOutsideQuotes(value)
  if (/[|;<>]|@\{|\b(?:Get|Set|New|Remove|Invoke|Start|Stop)-[A-Za-z]/i.test(outside)) {
    throw new Error(PORTABLE_BASH_REJECTED)
  }
  return splitChains(value).map(portableSegment).join(' && ')
}

function textOf(content) {
  return (content ?? []).map(block => block?.type === 'text' ? block.text : `[${block?.type ?? 'unknown'} content]`).join('\n')
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function apply(ctx, config = {}) {
  return ctx.tools.register({
    name: 'bash',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'One portable Linux-style developer command.' },
        description: { type: 'string', description: 'Concise 5-10 word description shown in the UI.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        workdir: { type: 'string', description: 'Relative working directory; defaults to the session workspace.' },
        run_in_background: { type: 'boolean', description: 'Run in background; omitted from the bootstrap schema.' },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (!object(args) || typeof args.command !== 'string' || typeof args.description !== 'string') {
        throw new Error(PORTABLE_BASH_REJECTED)
      }
      const command = translatePortableBash(args.command, config)
      const nativeArgs = {
        command,
        description: args.description,
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        ...(typeof args.workdir === 'string' ? { workdir: args.workdir } : {}),
        ...(args.run_in_background === true ? { run_in_background: true } : {}),
      }
      const result = await ctx.tools.execute({
        callId: `${exec.callId}:pwsh`,
        rootCallId: exec.rootCallId,
        parent: exec.token,
        name: 'pwsh',
        arguments: nativeArgs,
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        signal: exec.signal,
      })
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      if (result.isError) throw new Error(result.error.message)
      if (result.concludesTurn === true) exec.concludeTurn()
      return textOf(result.content)
    },
  })
}
