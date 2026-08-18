import { writeFile } from 'node:fs/promises'

const mode = process.argv[2]
const args = process.argv.slice(3)
const answer = {
  status: 'complete',
  summary: 'A verified synthetic image result.',
  answer: 'Synthetic visual answer.',
  observations: [{
    claim: 'The fixture is present.',
    evidence: { media_index: 0, locator: 'entire image' },
    confidence: 0.99,
  }],
  coverage: [
    { lane: 'task_answer', status: 'covered', note: 'Answered.' },
    { lane: 'global_context', status: 'covered', note: 'Inspected.' },
    { lane: 'uncertainty_audit', status: 'covered', note: 'No critical uncertainty.' },
  ],
  uncertainties: [],
  gaps: [],
  suggested_followups: [],
  boundary_reason: 'Fixture complete.',
}

if (mode === 'codex') {
  const outputIndex = args.indexOf('--output-last-message')
  if (outputIndex < 0) process.exit(41)
  await writeFile(args[outputIndex + 1], JSON.stringify(answer), 'utf8')
} else if (mode === 'claude') {
  process.stdout.write(JSON.stringify({ structured_output: answer }))
} else if (mode === 'hang') {
  setInterval(() => {}, 1_000)
} else {
  process.exit(42)
}
