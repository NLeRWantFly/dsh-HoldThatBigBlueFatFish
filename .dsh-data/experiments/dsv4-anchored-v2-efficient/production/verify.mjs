#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERSONA } from './progressive-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const preset = resolve(here, '..', '..', '..', '.agent-presets', 'dsv4-progressive-guarded')
const files = ['agent.cordis.yml', 'preset.yml', 'progressive-guard.mjs', 'model-policy.mjs', 'README.md']

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const contents = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(preset, file))])))
const composition = contents['agent.cordis.yml'].toString('utf8')
assert(composition.includes(`text: ${JSON.stringify(PERSONA)}`))
assert(composition.includes('complete: true'))
assert(composition.includes('includeRuntimeContext: false'))
assert.equal((composition.match(/id: dsv4-progressive-guard/g) ?? []).length, 1)
assert(composition.includes("name: './progressive-guard.mjs'"))
assert(!composition.includes('probe-stop'))
assert(!composition.includes('evaluation'))
for (const expected of [
  'bootstrapMaxEntries: 50',
  'maxMutationChars: 12000',
  'maxUnverifiedMutationChars: 24000',
  'maxPostCheckCalls: 2',
  'requestMaxTokens: 16384',
]) assert(composition.includes(expected))
assert.deepEqual(contents['progressive-guard.mjs'], await readFile(join(here, 'progressive-guard.mjs')))
assert.deepEqual(contents['model-policy.mjs'], await readFile(join(here, 'model-policy.mjs')))
assert.deepEqual(contents['README.md'], await readFile(join(here, 'README.md')))
for (const [file, content] of Object.entries(contents)) {
  assert.doesNotMatch(content.toString('utf8'), /\bsk-[A-Za-z0-9_-]{20,}\b/, `${file} contains a credential-like value`)
}

const result = {
  ok: true,
  presetId: 'dsv4-progressive-guarded',
  files: Object.fromEntries(files.map(file => [file, { bytes: contents[file].length, sha256: sha256(contents[file]) }])),
  invariants: {
    stableVerticalSlicePersona: true,
    modelSpecificPersona: true,
    runtimeContextDisabled: true,
    singlePluginRegistration: true,
    boundedRequestGeneration: true,
    semanticPromotion: true,
    convergenceGuard: true,
    noCredentials: true,
    pluginCopyByteIdentical: true,
  },
}
await writeFile(join(here, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))
