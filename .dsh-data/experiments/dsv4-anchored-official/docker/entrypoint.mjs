import { cp, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import net from 'node:net'

const home = process.env.DSH_HOME ?? '/run/dsh-home'
const presets = [
  'dsv4-official-standard-full',
  'dsv4-official-minimal-full',
  'dsv4-official-standard-anchored',
  'dsv4-official-minimal-fixed',
  'dsv4-official-minimal-anchored',
]

await mkdir(`${home}/.agent-presets`, { recursive: true })
for (const preset of presets) {
  await cp(`/mnt/presets/${preset}`, `${home}/.agent-presets/${preset}`, { recursive: true })
}

const dsh = spawn(process.execPath, [
  '/opt/dsh/apps/cli/lib/bin.js', 'web', '--host', '127.0.0.1', '--port', '3090',
], { stdio: 'inherit' })

const relay = net.createServer(client => {
  const upstream = net.connect(3090, '127.0.0.1')
  client.pipe(upstream)
  upstream.pipe(client)
  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', close)
  upstream.on('error', close)
})
relay.listen(3091, '0.0.0.0')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    relay.close()
    dsh.kill(signal)
  })
}
dsh.on('exit', code => relay.close(() => process.exit(code ?? 1)))
