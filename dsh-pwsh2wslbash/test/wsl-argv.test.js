import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWslArgv,
  linuxEnvironment,
  outerWorkdir,
  windowsPathToWsl,
  wslPathToWindows,
} from '../lib/wsl-argv.js'

test('maps Windows drive and WSL mount paths in both directions', () => {
  assert.equal(windowsPathToWsl('D:\\projfiles\\dsh-test2'), '/mnt/d/projfiles/dsh-test2')
  assert.equal(windowsPathToWsl('C:/Users/lenovo/.dsh'), '/mnt/c/Users/lenovo/.dsh')
  assert.equal(wslPathToWindows('/mnt/d/projfiles/dsh-test2'), 'D:\\projfiles\\dsh-test2')
  assert.equal(outerWorkdir('/mnt/d/projfiles/dsh-test2'), 'D:\\projfiles\\dsh-test2')
})

test('maps path-shaped environment values and replaces the Windows PATH', () => {
  const assignments = linuxEnvironment({
    env: { FOO: 'a b', PROJECT_DIR: 'D:\\work\\x' },
    dshEnv: { DSH_HOME: 'C:\\Users\\lenovo\\.dsh' },
  })
  assert.ok(assignments.includes('FOO=a b'))
  assert.ok(assignments.includes('PROJECT_DIR=/mnt/d/work/x'))
  assert.ok(assignments.includes('DSH_HOME=/mnt/c/Users/lenovo/.dsh'))
  assert.ok(assignments.includes('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'))
})

test('builds an argv vector without shell quoting', () => {
  const argv = buildWslArgv({
    distro: 'Ubuntu-20.04',
    wslExecutable: 'C:\\Windows\\System32\\wsl.exe',
    linuxShell: '/bin/bash',
    linuxPath: '/usr/local/bin:/usr/bin:/bin',
  }, {
    command: 'printf "%s\\n" "$FOO"',
    workdir: 'D:\\project with spaces',
    env: { FOO: 'a b' },
  })

  assert.deepEqual(argv.slice(0, 8), [
    'C:\\Windows\\System32\\wsl.exe',
    '-d',
    'Ubuntu-20.04',
    '--cd',
    'D:\\project with spaces',
    '--exec',
    '/usr/bin/env',
    'FOO=a b',
  ])
  assert.deepEqual(argv.slice(-3), ['/bin/bash', '-lc', 'printf "%s\\n" "$FOO"'])
})

test('rejects invalid environment names', () => {
  assert.throws(
    () => linuxEnvironment({ env: { 'BAD=NAME': 'value' } }),
    /invalid environment name/,
  )
})
