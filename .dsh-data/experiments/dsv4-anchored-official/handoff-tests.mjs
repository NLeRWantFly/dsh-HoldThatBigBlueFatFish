#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MODELTEST, PYTHON, execChecked, treeHash } from './lib.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'dsv4-official-handoff-'))
try {
  await execChecked(PYTHON, [join(MODELTEST, 'evaluator', 'make_broken_project.py')], { cwd: MODELTEST })
  const gitignore = join(MODELTEST, 'workspace', 'project2_task', '.gitignore')
  const gitignoreText = await readFile(gitignore, 'utf8')
  if (gitignoreText.includes('\r\n')) await writeFile(gitignore, gitignoreText.replaceAll('\r\n', '\n'), 'utf8')
  const hashes = []
  for (const name of ['one', 'two']) {
    const output = join(temporary, name)
    await execChecked(PYTHON, [
      join(MODELTEST, 'evaluator', 'prepare_candidate_handoff.py'),
      '--source', join(MODELTEST, 'workspace'),
      '--output', output,
    ], { cwd: MODELTEST })
    hashes.push(await treeHash(output))
  }
  assert.equal(hashes[0], hashes[1], `handoff hashes differ: ${hashes.join(', ')}`)
  console.log(JSON.stringify({ ok: true, handoffSha256: hashes[0] }))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
