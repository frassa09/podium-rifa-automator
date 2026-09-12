import { networkInterfaces } from 'node:os'
import { startServer } from './api/server.ts'

async function main(): Promise<void> {
  const srv = await startServer({ port: Number(process.env.PORT ?? 3000) })
  const { server } = srv
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 3000

  const ips = Object.values(networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => (i as { address: string }).address)

  console.log(`[rifa] API pronta`)
  console.log(`[rifa] Local:    http://localhost:${port}`)
  for (const ip of ips) console.log(`[rifa] Rede LAN: http://${ip}:${port}`)
  console.log(`[rifa] Acesse pelo celular na mesma rede Wi-Fi.`)
}

main().catch(e => {
  console.error('Falha ao iniciar:', e)
  process.exit(1)
})