// Executar: npx tsx tests/e2e.seco.ts
// Lê CPF/senha de variáveis de ambiente (nunca commitar credenciais).
import { PodiumSession } from '../src/podium/session.ts'

async function main() {
  const cpf = process.env.RIFA_CPF
  const senha = process.env.RIFA_SENHA
  if (!cpf || !senha) {
    console.error('Defina RIFA_CPF e RIFA_SENHA para o teste E2E seco.')
    process.exit(1)
  }
  const s = await PodiumSession.login(cpf, senha)
  console.log('Login OK. Turma:', s.turma)
  console.log('Rifas na tabela:', (await s.lerRifas()).length)
  console.log('Sessão válida:', await s.checarSessao())
}

main().catch(e => { console.error(e); process.exit(1) })