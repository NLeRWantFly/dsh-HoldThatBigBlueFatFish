#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  HERE,
  PRESET_ROOT,
  canonicalJson,
  readEvents,
  readJson,
  releaseRank,
  scanTreeForSecrets,
  scoreTrajectory,
  sha256,
  writeJson,
  writeTextSecure,
} from './lib.mjs'
import {
  MINIMAL_SYSTEM,
  OFFICIAL_BASE_URL,
  PRESET_IDS,
  PROBE_ORDER,
  PROJECT_ORDERS,
  ROUTE,
  matrixFor,
  shellTool,
} from './constants.mjs'
import { filterFirstRequest } from './plugins/anchored-tools.mjs'
import { filterEveryRequest } from './plugins/fixed-tools.mjs'
import { reportMarkdown } from './report.mjs'

const argv = process.argv.slice(2)

function option(name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

async function verifyImplementation() {
  assert.equal(MINIMAL_SYSTEM, 'You are a helpful software engineer assistant.')
  assert.equal(MINIMAL_SYSTEM.length, 46)
  assert.deepEqual(ROUTE, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.equal(OFFICIAL_BASE_URL, 'https://api.deepseek.com')
  assert.deepEqual(PROBE_ORDER, ['standard-full', 'minimal-full', 'standard-anchored', 'minimal-fixed', 'minimal-anchored'])
  assert.deepEqual(PROJECT_ORDERS['windows-native'], ['standard-full', 'minimal-fixed', 'minimal-anchored'])
  assert.deepEqual(PROJECT_ORDERS['linux-docker'], ['minimal-anchored', 'standard-full', 'minimal-fixed'])
  assert.equal(matrixFor('windows-native').length, 8)
  assert.equal(matrixFor('linux-docker').length, 8)
  assert.deepEqual(await readJson(join(HERE, 'pricing.json')), (await import('./constants.mjs')).PRICING)
  assert.deepEqual(await readJson(join(HERE, 'matrix.json')), {
    probe: PROBE_ORDER,
    project2: PROJECT_ORDERS,
  })

  const toolCatalog = {
    sections: [], contexts: [], variables: {},
    tools: [{ name: 'read', schema: { a: 1 } }, { name: 'pwsh', schema: { b: 2 } }, { name: 'glob', schema: { c: 3 } }],
  }
  const initial = filterFirstRequest(toolCatalog, [])
  assert.deepEqual(initial.tools.map(tool => tool.name), ['read', 'pwsh'])
  assert.deepEqual(filterFirstRequest(toolCatalog, [{ type: 'tool/result' }]).tools.map(tool => tool.name), ['read', 'pwsh'])
  assert.deepEqual(filterFirstRequest(toolCatalog, [{ type: 'assistant/message' }]).tools.map(tool => tool.name), ['read', 'pwsh'])
  assert.equal(filterFirstRequest(toolCatalog, [{ type: 'tool/call' }]), toolCatalog)
  assert.deepEqual(initial.tools.map(tool => tool.name), ['read', 'pwsh'], 'same assembled request changed after durable event')
  assert.deepEqual(filterEveryRequest(toolCatalog).tools.map(tool => tool.name), ['read', 'pwsh'])

  const generated = await readJson(join(HERE, 'generated-presets.json'))
  for (const [condition, presetId] of Object.entries(PRESET_IDS)) {
    const text = await readFile(join(PRESET_ROOT, presetId, 'agent.cordis.yml'), 'utf8')
    assert(text.startsWith(`# Generated from DSH Standard at ${generated.standardSha256}`), `${condition}: wrong Standard source hash`)
    assert.equal((text.match(/id: dsv4-official-probe-stop/g) ?? []).length, 1)
    if (condition.startsWith('minimal-')) {
      const persona = text.slice(text.indexOf('- id: persona'), text.indexOf('\n- id: agent-instructions'))
      assert(persona.includes(`text: ${MINIMAL_SYSTEM}`))
      assert(persona.includes('complete: true'))
      assert(persona.includes('includeRuntimeContext: false'))
      assert(!persona.includes('You are a coding agent powered by'))
    }
  }
  return {
    minimalSystemChars: MINIMAL_SYSTEM.length,
    matrixSizes: { windows: matrixFor('windows-native').length, linux: matrixFor('linux-docker').length },
    generatedStandardSha256: generated.standardSha256,
    durablePromotionUnitTests: true,
  }
}

function rawHeaders(events) {
  return events.filter(event => event.type === 'request/header').map(event => event.data?.header ?? {})
}

function schemaByName(tools) {
  return new Map((tools ?? []).map(tool => [tool.name, canonicalJson(tool)]))
}

function terminalError(events) {
  return events.find(event => event.type === 'turn/end' && event.data?.reason?.kind === 'error')?.data?.reason
}

function compareProjectQuality(standard, anchored, effectFailures) {
  if (!standard || !anchored) return
  if (!(anchored.officialScore >= standard.officialScore)) effectFailures.push('Minimal Anchored Ability is below Standard')
  if (!(anchored.shipDraft >= standard.shipDraft)) effectFailures.push('Minimal Anchored Ship is below Standard')
  if (releaseRank(anchored.releaseClassHint) < releaseRank(standard.releaseClassHint)) {
    effectFailures.push('Minimal Anchored Release class is below Standard')
  }
  const standardBlockers = new Set(standard.blockers ?? [])
  const newBlockers = (anchored.blockers ?? []).filter(blocker => !standardBlockers.has(blocker))
  if (newBlockers.length > 0) effectFailures.push(`Minimal Anchored added blockers: ${newBlockers.join(', ')}`)
}

async function verifyRun(runDir) {
  const implementation = await verifyImplementation()
  const manifest = await readJson(join(runDir, 'manifest.json'))
  const storedScores = await readJson(join(runDir, 'scores.json'))
  const projectResults = await readJson(join(runDir, 'project2-results.json')).catch(() => [])
  const errors = []
  const warnings = []
  const effectFailures = []
  const expected = matrixFor(manifest.platform).filter(sample => manifest.suites.includes(sample.suite))
  if (manifest.samples.length !== expected.length) errors.push(`sample count ${manifest.samples.length}, expected ${expected.length}`)
  if (new Set(manifest.samples.map(sample => sample.id)).size !== manifest.samples.length) errors.push('duplicate successful sample id')
  const expectedIds = new Set(expected.map(sample => sample.id))
  for (const sample of manifest.samples) if (!expectedIds.has(sample.id)) errors.push(`unexpected sample ${sample.id}`)
  if (manifest.route?.provider !== ROUTE.provider || manifest.route?.model !== ROUTE.model || manifest.route?.reasoningEffort !== ROUTE.reasoningEffort) {
    errors.push(`manifest route mismatch: ${JSON.stringify(manifest.route)}`)
  }
  if (manifest.officialBaseUrl !== OFFICIAL_BASE_URL) errors.push(`official base URL mismatch: ${manifest.officialBaseUrl}`)
  const handoffHashes = new Set(manifest.samples.map(sample => sample.handoffSha256).filter(Boolean))
  if (handoffHashes.size !== 1 && manifest.samples.length > 1) errors.push(`handoff hashes differ: ${[...handoffHashes].join(', ')}`)

  const scores = []
  const eventsByCondition = new Map()
  for (const sample of manifest.samples) {
    const events = await readEvents(join(runDir, sample.eventFile))
    if (terminalError(events)) errors.push(`${sample.id}: terminal provider error`)
    const score = scoreTrajectory(sample, events)
    scores.push(score)
    eventsByCondition.set(`${sample.suite}:${sample.condition}`, events)
    if (score.route.provider !== ROUTE.provider || score.route.model !== ROUTE.model || score.route.reasoningEffort !== ROUTE.reasoningEffort) {
      errors.push(`${sample.id}: request route mismatch ${JSON.stringify(score.route)}`)
    }
    if (sample.suite === 'probe' && score.requestCount > 3) errors.push(`${sample.id}: probe exceeded three assistant messages`)
    const facts = sample.condition.startsWith('minimal-')
    if (facts) {
      if (!score.minimalSystemExact) errors.push(`${sample.id}: Minimal system changed across requests`)
      if (score.firstSystem !== MINIMAL_SYSTEM) errors.push(`${sample.id}: Minimal first system is not byte exact`)
      if (score.harnessIdentityPresent) errors.push(`${sample.id}: Harness identity leaked into Minimal system`)
      if (score.runtimeContextMessages !== 0) errors.push(`${sample.id}: runtime-context snapshot appeared in Minimal history`)
    }
    if (sample.condition.endsWith('-anchored') || sample.condition === 'minimal-fixed') {
      const expectedFirstTools = new Set(['read', shellTool(manifest.platform)])
      if (score.firstToolNames.length !== 2 || score.firstToolNames.some(name => !expectedFirstTools.has(name))) {
        errors.push(`${sample.id}: first catalog is ${score.firstToolNames.join(', ')}, expected read + native shell`)
      }
    }
    if (sample.condition.endsWith('-anchored') && score.promotion.durableToolCallSeen) {
      if (score.requestCount >= 2 && !score.promotion.promotedOnFollowingRequest) {
        errors.push(`${sample.id}: durable tool/call did not promote on the following request`)
      }
      if (!score.promotion.systemStayedMinimal) errors.push(`${sample.id}: Minimal system changed after promotion`)
    }
    if (sample.condition === 'minimal-fixed') {
      for (const message of score.firstThree) {
        if (message.toolNames.length !== 2) errors.push(`${sample.id}: Minimal Fixed exposed ${message.toolNames.length} tools on request ${message.index}`)
      }
    }
  }
  if (canonicalJson(storedScores, 2) !== canonicalJson(scores, 2)) {
    errors.push(`scores.json does not replay byte-identically: stored=${sha256(canonicalJson(storedScores, 2))}, replay=${sha256(canonicalJson(scores, 2))}`)
  }

  const standardProbeEvents = eventsByCondition.get('probe:standard-full')
  if (standardProbeEvents) {
    const standardFull = rawHeaders(standardProbeEvents).sort((a, b) => (b.tools?.length ?? 0) - (a.tools?.length ?? 0))[0]
    const standardSchemas = schemaByName(standardFull.tools)
    for (const sample of manifest.samples.filter(candidate => candidate.suite === 'probe')) {
      const headers = rawHeaders(eventsByCondition.get(`probe:${sample.condition}`))
      const largest = [...headers].sort((a, b) => (b.tools?.length ?? 0) - (a.tools?.length ?? 0))[0]
      for (const tool of largest.tools ?? []) {
        if (standardSchemas.has(tool.name) && standardSchemas.get(tool.name) !== canonicalJson(tool)) {
          errors.push(`${sample.id}: shared schema for ${tool.name} differs from Standard`)
        }
      }
      if (sample.condition === 'minimal-full' && canonicalJson(largest.tools ?? []) !== canonicalJson(standardFull.tools ?? [])) {
        errors.push(`${sample.id}: Minimal Full catalog is not byte-identical to Standard Full`)
      }
      if (sample.condition.endsWith('-anchored')) {
        const score = scores.find(row => row.id === sample.id)
        if (score?.promotion.promotedToolCount && canonicalJson(largest.tools ?? []) !== canonicalJson(standardFull.tools ?? [])) {
          errors.push(`${sample.id}: promoted catalog is not byte-identical to Standard Full`)
        }
      }
    }
  }

  const standardProbe = scores.find(score => score.suite === 'probe' && score.condition === 'standard-full')
  const anchoredProbe = scores.find(score => score.suite === 'probe' && score.condition === 'minimal-anchored')
  if (anchoredProbe) {
    if (!anchoredProbe.firstCompliant || anchoredProbe.firstBreadth > 1 || anchoredProbe.firstToolCallCount > 2) {
      effectFailures.push('Minimal Anchored probe did not converge to breadth <= 1 and at most two calls')
    }
    if (standardProbe && !(anchoredProbe.firstReasoningChars < standardProbe.firstReasoningChars)) {
      effectFailures.push('Minimal Anchored first reasoning was not shorter than Standard')
    }
    if (standardProbe && !(anchoredProbe.firstNarrationCharsBeforeAction < standardProbe.firstNarrationCharsBeforeAction)) {
      effectFailures.push('Minimal Anchored action preface was not shorter than Standard')
    }
  }
  const standardProject = projectResults.find(result => result.condition === 'standard-full')
  const anchoredProject = projectResults.find(result => result.condition === 'minimal-anchored')
  compareProjectQuality(standardProject, anchoredProject, effectFailures)
  const anchoredProjectScore = scores.find(score => score.suite === 'project2' && score.condition === 'minimal-anchored')
  if (anchoredProjectScore && anchoredProjectScore.promotion.outsideBootstrapToolsUsed.length === 0) {
    effectFailures.push('Minimal Anchored Project2 did not use a restored Standard tool after the first request')
  }

  const secretScan = await scanTreeForSecrets(runDir)
  if ((manifest.failedAttempts ?? []).length > 0) warnings.push(`${manifest.failedAttempts.length} failed attempts are retained; successful sample ids were not rerun`)
  const verification = {
    verifiedAt: new Date().toISOString(),
    runDir,
    platform: manifest.platform,
    implementation,
    structureOk: errors.length === 0,
    effectPass: effectFailures.length === 0,
    ok: errors.length === 0 && effectFailures.length === 0,
    errors,
    effectFailures,
    warnings,
    secretScan,
    replayScoresSha256: sha256(canonicalJson(scores, 2)),
  }
  await writeJson(join(runDir, 'verification.json'), verification)
  await writeTextSecure(join(runDir, 'report.md'), reportMarkdown({ manifest, scores, projectResults, verification: {
    ...verification,
    errors: [...errors, ...effectFailures.map(item => `EFFECT: ${item}`)],
  } }))
  return verification
}

const implementation = await verifyImplementation()
const run = option('--run')
if (!run) {
  console.log(JSON.stringify({ ok: true, implementation }, null, 2))
} else {
  const verification = await verifyRun(resolve(run))
  console.log(JSON.stringify(verification, null, 2))
  if (!verification.structureOk) process.exitCode = 1
}
