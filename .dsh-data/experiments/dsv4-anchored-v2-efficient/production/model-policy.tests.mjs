#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  FLASH_PERSONA,
  PRO_PERSONA,
  applyModelPersona,
  isFlashModel,
  personaForModel,
} from './model-policy.mjs'

assert.equal(isFlashModel('deepseek-v4-pro'), false)
assert.equal(isFlashModel('deepseek-v4-flash'), true)
assert.equal(isFlashModel('DEEPSEEK-V4-FLASH-202608'), true)
assert.equal(personaForModel('deepseek-v4-pro'), PRO_PERSONA)
assert.equal(personaForModel('deepseek-v4-flash'), FLASH_PERSONA)

assert.equal(PRO_PERSONA.split(/\s+/).length < 40, true)
assert.match(PRO_PERSONA, /only the next runnable piece/)
assert.match(PRO_PERSONA, /stop when the relevant check passes/)
assert.match(PRO_PERSONA, /label simulated checks as simulated/)
assert.doesNotMatch(PRO_PERSONA, /think deeply|architecture, edge cases|information is complete/i)

assert.match(FLASH_PERSONA, /decide the task type \(build or fix\)/)
assert.match(FLASH_PERSONA, /do not repeat completed steps/)
assert.match(FLASH_PERSONA, /exhaustive grep\/glob scans/)

const original = [
  { name: 'persona', text: 'standard', order: 0 },
  { name: 'plan-mode', text: 'plan', order: 10 },
  { name: 'runtime-persona-note', text: 'remove me', order: 20 },
]
const pro = applyModelPersona(original, 'deepseek-v4-pro')
const flash = applyModelPersona(original, 'deepseek-v4-flash')
assert.deepEqual(pro.map(section => section.name), ['dsv4-model-persona', 'plan-mode'])
assert.equal(pro[0].text, PRO_PERSONA)
assert.equal(flash[0].text, FLASH_PERSONA)
assert.equal(original[0].text, 'standard')

console.log('model policy tests passed')
