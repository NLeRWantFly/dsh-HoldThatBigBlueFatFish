import path from 'node:path'

const WINDOWS_ABSOLUTE_PATH = /^([A-Za-z]):[\\/](.*)$/
const WSL_MOUNT_PATH = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/
const WSL_UNC_PATH = /^\\\\wsl(?:\.localhost)?\\([^\\]+)\\?(.*)$/i
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const LINUX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export function windowsPathToWsl(value) {
  const drive = WINDOWS_ABSOLUTE_PATH.exec(value)
  if (drive !== null) {
    const letter = drive[1].toLowerCase()
    const rest = drive[2].replaceAll('\\', '/')
    return rest === '' ? `/mnt/${letter}` : `/mnt/${letter}/${rest}`
  }

  const unc = WSL_UNC_PATH.exec(value)
  if (unc !== null) {
    const rest = unc[2].replaceAll('\\', '/')
    return rest === '' ? '/' : `/${rest}`
  }

  return value
}

export function wslPathToWindows(value) {
  const mount = WSL_MOUNT_PATH.exec(value)
  if (mount === null) return value
  const drive = mount[1].toUpperCase()
  const rest = (mount[2] ?? '').replaceAll('/', '\\')
  return rest === '' ? `${drive}:\\` : `${drive}:\\${rest}`
}

export function outerWorkdir(workdir) {
  const converted = wslPathToWindows(workdir)
  if (path.win32.isAbsolute(converted)) return converted
  return path.win32.resolve(converted)
}

export function linuxEnvironment(spec, linuxPath = LINUX_PATH) {
  const merged = {
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    ...spec.env,
    ...spec.dshEnv,
    PATH: linuxPath,
  }

  return Object.entries(merged)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rawValue]) => {
      if (!ENVIRONMENT_NAME.test(key)) {
        throw new Error(`dsh-pwsh2wslbash: invalid environment name '${key}'`)
      }
      const value = windowsPathToWsl(String(rawValue))
      return `${key}=${value}`
    })
}

export function buildWslArgv(config, spec) {
  return [
    config.wslExecutable,
    '-d',
    config.distro,
    '--cd',
    spec.workdir,
    '--exec',
    '/usr/bin/env',
    ...linuxEnvironment(spec, config.linuxPath),
    config.linuxShell,
    '-lc',
    spec.command,
  ]
}
