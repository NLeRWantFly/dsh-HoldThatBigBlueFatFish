import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { buildVisionPrompt, parseBackendJson } from './protocol.mjs'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nativeCommand(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

export function selectedBackend(config = {}, env = process.env) {
  const selected = nonEmpty(config.backend) ?? nonEmpty(env.DSH_VISION_BACKEND) ?? 'codex'
  if (selected !== 'codex' && selected !== 'claude') {
    throw new Error(`unsupported vision backend: ${selected}`)
  }
  return selected
}

export function buildCodexInvocation(config, media, prompt, paths) {
  const codex = config.codex ?? {}
  const command = nonEmpty(codex.command)
    ?? nonEmpty(process.env.DSH_VISION_CODEX_COMMAND)
    ?? nativeCommand('codex')
  const args = [...(Array.isArray(codex.commandArgs) ? codex.commandArgs : []), 'exec']
  if (nonEmpty(codex.profile)) args.push('--profile', codex.profile.trim())
  if (nonEmpty(codex.model)) args.push('--model', codex.model.trim())
  for (const override of Array.isArray(codex.configOverrides) ? codex.configOverrides : []) {
    if (nonEmpty(override)) args.push('-c', override.trim())
  }
  args.push(
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--output-schema', paths.schema,
    '--output-last-message', paths.output,
    '-C', paths.cwd,
  )
  for (const item of media) args.push('--image', item.path)
  args.push('--', prompt)
  return { command, args }
}

export function buildClaudeInvocation(config, media, prompt, schemaText) {
  const claude = config.claude ?? {}
  const command = nonEmpty(claude.command)
    ?? nonEmpty(process.env.DSH_VISION_CLAUDE_COMMAND)
    ?? nativeCommand('claude')
  const args = [
    ...(Array.isArray(claude.commandArgs) ? claude.commandArgs : []),
    '-p',
    '--bare',
    '--output-format', 'json',
    '--json-schema', schemaText,
    '--tools', 'Read',
    '--allowedTools', 'Read',
    '--disallowedTools', 'mcp__*',
    '--max-turns', String(positiveInteger(claude.maxTurns, 8)),
  ]
  if (nonEmpty(claude.model)) args.push('--model', claude.model.trim())
  if (nonEmpty(claude.effort)) args.push('--effort', claude.effort.trim())
  const mediaDirective = `Read and inspect these exact media paths before answering: ${media.map(item => JSON.stringify(item.path)).join(', ')}`
  args.push(`${mediaDirective}\n${prompt}`)
  return { command, args }
}

export function spawnCapture(command, args, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, 180_000)
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 2_000_000)
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error('vision CLI aborted'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let terminationError
    let timer

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(value)
    }
    const collect = (target, chunk, current) => {
      const remaining = Math.max(0, maxOutputBytes - current)
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      return current + chunk.length
    }
    child.stdout.on('data', (chunk) => { stdoutBytes = collect(stdout, chunk, stdoutBytes) })
    child.stderr.on('data', (chunk) => { stderrBytes = collect(stderr, chunk, stderrBytes) })
    child.on('error', error => finish(error))
    child.on('close', (code, signal) => {
      if (terminationError) {
        finish(terminationError)
        return
      }
      const result = {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (result.code !== 0) {
        finish(new Error(`vision CLI exited ${result.code}: ${result.stderr.slice(0, 4_000) || result.stdout.slice(0, 4_000)}`))
      } else {
        finish(undefined, result)
      }
    })
    const abort = () => {
      terminationError = options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('vision CLI aborted')
      if (!child.kill()) finish(terminationError)
    }
    timer = setTimeout(() => {
      terminationError = new Error(`vision CLI timed out after ${timeoutMs}ms`)
      if (!child.kill()) finish(terminationError)
    }, timeoutMs)
    timer.unref?.()
    options.signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function runVisionBackend(input) {
  const backend = selectedBackend(input.config)
  const prompt = buildVisionPrompt(input.request, input.media)
  const schemaText = await readFile(input.schemaPath, 'utf8')
  const common = {
    cwd: input.cwd,
    signal: input.signal,
    timeoutMs: input.config.timeoutMs,
    maxOutputBytes: input.config.maxBackendOutputBytes,
  }

  if (backend === 'codex') {
    const invocation = buildCodexInvocation(input.config, input.media, prompt, {
      schema: input.schemaPath,
      output: input.outputPath,
      cwd: input.cwd,
    })
    await spawnCapture(invocation.command, invocation.args, common)
    return parseBackendJson(await readFile(input.outputPath, 'utf8'))
  }

  const invocation = buildClaudeInvocation(input.config, input.media, prompt, schemaText)
  const result = await spawnCapture(invocation.command, invocation.args, common)
  return parseBackendJson(result.stdout)
}
