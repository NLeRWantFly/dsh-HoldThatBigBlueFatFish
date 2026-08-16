import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { buildWslArgv, LINUX_PATH, outerWorkdir } from './lib/wsl-argv.js'

const DEFAULT_WSL_EXECUTABLE = path.win32.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'wsl.exe',
)

export class WslBashExecutor extends LocalBashExecutor {
  static inject = ['subprocess']

  static Config = z.object({
    distro: z.string().default('Ubuntu-20.04'),
    wslExecutable: z.string().default(DEFAULT_WSL_EXECUTABLE),
    linuxShell: z.string().default('/bin/bash'),
    linuxPath: z.string().default(LINUX_PATH),
    cwd: z.string(),
    timeoutMs: z.number().default(120000),
    maxTimeoutMs: z.number().default(600000),
    maxOutputBytes: z.number().default(64000),
    maxSpillBytes: z.number().default(64 * 1024 * 1024),
    graceMs: z.number().default(3000),
  })

  constructor(ctx, config) {
    if (process.platform !== 'win32') {
      throw new Error('dsh-pwsh2wslbash: this executor must be loaded by Windows DSH')
    }

    super(ctx, {
      cwd: config.cwd,
      timeoutMs: config.timeoutMs,
      maxTimeoutMs: config.maxTimeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      maxSpillBytes: config.maxSpillBytes,
      graceMs: config.graceMs,
    })

    // Cordis exposes services through a proxy, so this state must be proxy-readable.
    this.bridge = Object.freeze({
      distro: config.distro,
      wslExecutable: config.wslExecutable,
      linuxShell: config.linuxShell,
      linuxPath: config.linuxPath,
    })
  }

  execution(spec) {
    const argv = buildWslArgv(this.bridge, spec)
    return {
      argv,
      spec: {
        ...spec,
        workdir: outerWorkdir(spec.workdir),
      },
    }
  }

  run(spec) {
    const execution = this.execution(spec)
    return this.runArgv(execution.spec, execution.argv)
  }

  start(spec) {
    const execution = this.execution(spec)
    return this.startArgv(execution.spec, execution.argv)
  }
}

export default WslBashExecutor
