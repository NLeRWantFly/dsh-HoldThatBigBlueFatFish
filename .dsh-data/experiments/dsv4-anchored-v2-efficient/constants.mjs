export const MINIMAL_PERSONA = 'You are a helpful software engineer assistant.'

export const COMPACT_CONTRACT = 'First-step contract: begin with the smallest evidence-gathering action. Use at most two read or shell calls, limited to paths or commands named by the user. Do not recursively inventory the workspace, narrate a plan, delegate, use the web, or start background work. Expand only after bounded evidence, and stop when the requested acceptance checks pass.'

export const SINGLE_ACTION_CONTRACT = 'First action only: make one bounded read or shell call using a user-named path or command. No preamble, directory listing, or recursion. After its result, work incrementally and stop when the acceptance checks pass.'

export const CAPABILITY_NOTE = 'Additional tools become available after the first successful read.'

export const ROUTE = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max',
})

export const PRESETS = Object.freeze({
  'v2-minimal-core': 'dsv4-official-v2-minimal-core',
  'v2-compact-core': 'dsv4-official-v2-compact-core',
  'v3-single-core': 'dsv4-official-v3-single-core',
  'v4-read-core': 'dsv4-official-v4-read-core',
  'v5-read-noted-core': 'dsv4-official-v5-read-noted-core',
  'v6-prefetched-core': 'dsv4-official-v6-prefetched-core',
})

export const PROBE_SESSION_PREFIX = 'probe-dsv4-v2-'
export const MICRO_SESSION_PREFIX = 'probe-dsv4-v3-'
export const READ_MICRO_SESSION_PREFIX = 'probe-dsv4-v4-'
export const NOTED_READ_MICRO_SESSION_PREFIX = 'probe-dsv4-v5-'
export const PREFETCH_MICRO_SESSION_PREFIX = 'probe-dsv4-v6-'
export const PROJECT_SESSION_PREFIX = 'project-dsv4-v2-'
export const CORE_TOOLS = Object.freeze(['read', 'edit', 'write', 'grep', 'glob'])
export const MAX_PROBE_ASSISTANT_MESSAGES = 3

export function nativeShell(platform) {
  if (platform === 'windows-native' || platform === 'win32') return 'pwsh'
  if (platform === 'linux-docker' || platform === 'linux') return 'bash'
  throw new Error(`unsupported platform: ${platform}`)
}
