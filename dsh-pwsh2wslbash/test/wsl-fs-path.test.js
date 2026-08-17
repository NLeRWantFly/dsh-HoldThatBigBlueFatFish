import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeFsResolve } from '../lib/wsl-fs-path.js'

test('maps WSL file-tool paths and cwd into the Windows filesystem namespace', () => {
  const options = { cwd: '/mnt/d/projfiles/nomansky', signal: 'sentinel' }
  const normalized = normalizeFsResolve(
    '/mnt/d/projfiles/nomansky/mona_svg/generate.py',
    options,
  )

  assert.deepEqual(normalized, {
    filePath: 'D:\\projfiles\\nomansky\\mona_svg\\generate.py',
    options: { cwd: 'D:\\projfiles\\nomansky', signal: 'sentinel' },
  })
  assert.notEqual(normalized.options, options)
})

test('leaves relative and Linux-native paths unchanged', () => {
  const options = { cwd: 'D:\\projfiles\\nomansky' }
  assert.deepEqual(normalizeFsResolve('generate.py', options), {
    filePath: 'generate.py',
    options,
  })
  assert.deepEqual(normalizeFsResolve('/tmp/generate.py'), {
    filePath: '/tmp/generate.py',
    options: undefined,
  })
})

test('does not create the duplicated D:\\mnt\\d path', () => {
  const normalized = normalizeFsResolve('/mnt/d/projfiles/nomansky/generate.py')
  assert.equal(normalized.filePath, 'D:\\projfiles\\nomansky\\generate.py')
  assert.equal(normalized.filePath.includes('\\mnt\\d\\'), false)
})
