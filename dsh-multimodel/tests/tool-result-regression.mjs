import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.argv[2]
const expected = process.argv[3] ?? 'rewritten'
if (!modulePath || !['missed', 'rewritten'].includes(expected)) {
  console.error('usage: node tool-result-regression.mjs MODULE_PATH [missed|rewritten]')
  process.exit(64)
}

const bridge = await import(`${pathToFileURL(resolve(modulePath)).href}?run=${Date.now()}`)
const refs = [
  {
    attachmentId: 'sha256:153c522fa348b04458bd8320e2b8626dc268210ca8c5bd75cc98ea6369047d8e',
    mediaType: 'image/png', bytes: 148466, width: 1280, height: 720, name: '02-day.png',
  },
  {
    attachmentId: 'sha256:24e2b9176e3f14798ac3c2d1488a445f5b6a89ca3fec08b2ceb4b844143e0f49',
    mediaType: 'image/png', bytes: 183323, width: 1280, height: 720, name: '03-terrain.png',
  },
]

function resultMessage(ref, index) {
  const callId = `call-0${index}`
  return {
    role: 'user', id: `result-${index}`, source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result', toolCallId: callId, isError: false,
      content: [
        { type: 'text', text: `<path>${ref.name}</path>\n<type>image</type>` },
        { type: 'image', attachment: ref },
      ],
    }],
  }
}

const events = refs.map((ref, seq) => ({
  seq,
  type: 'tool/result',
  data: { turn: 1, step: 99, message: resultMessage(ref, seq) },
}))
const session = {
  events,
  surface: { nodes: [0, 1] },
  append(type, data, options) {
    const event = { seq: this.events.length, type, data, ...options }
    this.events.push(event)
    const start = this.surface.nodes.indexOf(options.surfaceOp.start)
    const end = this.surface.nodes.indexOf(options.surfaceOp.end)
    this.surface.nodes.splice(start, end - start + 1, event.seq)
    return event
  },
}

const migration = bridge.rewriteHistoricalImages({ id: 'console-go-regression', session })
const remainingRaw = session.surface.nodes.reduce((count, seq) => (
  count + bridge.extractRawImageRefs(session.events[seq].data.message.content).length
), 0)

if (expected === 'missed') {
  assert.equal(migration.rewritten, 0)
  assert.equal(remainingRaw, 2)
  console.log('BASELINE PASS: branch=tool_result_image migration=missed raw_image_blocks=2 provider_result=messages[203].image_url')
} else {
  assert.equal(migration.rewritten, 2)
  assert.deepEqual(migration.latestRefs, refs)
  assert.equal(remainingRaw, 0)
  assert.equal(JSON.stringify(session.surface.nodes.map(seq => session.events[seq])).includes('image_url'), false)
  console.log('REGRESSION PASS: branch=tool_result_image migration=rewritten raw_image_blocks=0 provider_payload=text_only')
}
