import { wslPathToWindows } from './wsl-argv.js'

export function normalizeFsResolve(filePath, options) {
  const normalizedPath = wslPathToWindows(filePath)
  if (options?.cwd === undefined) {
    return { filePath: normalizedPath, options }
  }

  const normalizedCwd = wslPathToWindows(options.cwd)
  return {
    filePath: normalizedPath,
    options: normalizedCwd === options.cwd
      ? options
      : { ...options, cwd: normalizedCwd },
  }
}
