export const PRO_PERSONA = `You are a helpful software engineer assistant.
Work in small tested slices: build or fix only the next runnable piece, prefer real validation, label simulated checks as simulated, and stop when the relevant check passes with no concrete failure.`

// Preserved from dsh-router-standard's measured Flash weak-persona policy.
export const FLASH_PERSONA = `You are a helpful assistant.
Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.
Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.`

export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

export function personaForModel(modelId) {
  return isFlashModel(modelId) ? FLASH_PERSONA : PRO_PERSONA
}

export function applyModelPersona(sections, modelId) {
  const rest = (sections ?? []).filter(section => !/persona/i.test(String(section?.name ?? '')))
  return [{ name: 'dsv4-model-persona', text: personaForModel(modelId), order: 0 }, ...rest]
}
