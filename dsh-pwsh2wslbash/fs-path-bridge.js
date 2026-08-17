import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { normalizeFsResolve } from './lib/wsl-fs-path.js'

export class WslPathFileSystem extends SandboxedFileSystem {
  async resolve(filePath, options) {
    const normalized = normalizeFsResolve(filePath, options)
    return super.resolve(normalized.filePath, normalized.options)
  }

  async lstat(filePath, options, signal) {
    const normalized = normalizeFsResolve(filePath, options)
    return super.lstat(normalized.filePath, normalized.options, signal)
  }
}

export default WslPathFileSystem
