import { networkInterfaces } from 'node:os'
import { startServer } from './api/server.ts'

// O Render espera ~30 s entre SIGTERM e SIGKILL.
const ESPERA_ENCERRAR_MS = 25_000

async function main(): Promise<void> {
  const srv = await startServer({ port: Number(process.env.PORT ?? 3000) })
  const { server } = srv

  // Erro inesperado em qualquer lugar: registra e para os jobs (nunca seguir enviando no escuro).
  process.on('unhandledRejection', e => {
    console.error('[rifa] unhandledRejection — parando jobs ativos:', e)
    srv.pararTodos()
  })

  let encerrando = false
  const encerrar = async (sinal: string) => {
    if (encerrando) return
    encerrando = true
    console.log(`[rifa] ${sinal}: parando jobs antes do próximo envio…`)
    srv.pararTodos()
    const limpo = await srv.aguardarRunners(ESPERA_ENCERRAR_MS)
    if (!limpo) console.error('[rifa] runner não terminou a tempo; linhas em envio serão conferidas na próxima subida')
    server.close()
    await srv.banco.fechar().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGTERM', () => void encerrar('SIGTERM'))
  process.on('SIGINT', () => void encerrar('SIGINT'))

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
