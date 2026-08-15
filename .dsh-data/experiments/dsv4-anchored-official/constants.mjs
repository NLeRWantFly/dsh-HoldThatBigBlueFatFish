export const MINIMAL_SYSTEM = 'You are a helpful software engineer assistant.'

export const OFFICIAL_BASE_URL = 'https://api.deepseek.com'

export const ROUTE = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max',
})

export const PRESET_IDS = Object.freeze({
  'standard-full': 'dsv4-official-standard-full',
  'minimal-full': 'dsv4-official-minimal-full',
  'standard-anchored': 'dsv4-official-standard-anchored',
  'minimal-fixed': 'dsv4-official-minimal-fixed',
  'minimal-anchored': 'dsv4-official-minimal-anchored',
})

export const PROBE_ORDER = Object.freeze([
  'standard-full',
  'minimal-full',
  'standard-anchored',
  'minimal-fixed',
  'minimal-anchored',
])

export const PROJECT_ORDERS = Object.freeze({
  'windows-native': Object.freeze(['standard-full', 'minimal-fixed', 'minimal-anchored']),
  'linux-docker': Object.freeze(['minimal-anchored', 'standard-full', 'minimal-fixed']),
})

export const CONDITION_FACTS = Object.freeze({
  'standard-full': Object.freeze({ system: 'standard', firstTools: 'full', laterTools: 'full' }),
  'minimal-full': Object.freeze({ system: 'minimal', firstTools: 'full', laterTools: 'full' }),
  'standard-anchored': Object.freeze({ system: 'standard', firstTools: 'bootstrap', laterTools: 'full' }),
  'minimal-fixed': Object.freeze({ system: 'minimal', firstTools: 'bootstrap', laterTools: 'bootstrap' }),
  'minimal-anchored': Object.freeze({ system: 'minimal', firstTools: 'bootstrap', laterTools: 'full' }),
})

export const PROBE_SESSION_PREFIX = 'probe-dsv4-official-'
export const PROJECT_SESSION_PREFIX = 'project-dsv4-official-'
export const MAX_PROBE_ASSISTANT_MESSAGES = 3

export const PRICING = Object.freeze({
  model: 'deepseek-v4-pro',
  currency: 'USD',
  unitTokens: 1_000_000,
  cacheHitInput: 0.003625,
  cacheMissInput: 0.435,
  output: 0.87,
  capturedOn: '2026-08-15',
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
})

export function shellTool(platform) {
  if (platform === 'windows-native' || platform === 'win32') return 'pwsh'
  if (platform === 'linux-docker' || platform === 'linux') return 'bash'
  throw new Error(`unsupported evaluation platform: ${platform}`)
}

export function matrixFor(platform) {
  const projectOrder = PROJECT_ORDERS[platform]
  if (projectOrder === undefined) throw new Error(`unsupported evaluation platform: ${platform}`)
  return [
    ...PROBE_ORDER.map((condition, index) => ({
      id: `probe-${index + 1}-${condition}`,
      suite: 'probe',
      condition,
      preset: PRESET_IDS[condition],
      repeat: 1,
    })),
    ...projectOrder.map((condition, index) => ({
      id: `project2-${index + 1}-${condition}`,
      suite: 'project2',
      condition,
      preset: PRESET_IDS[condition],
      repeat: 1,
    })),
  ]
}
