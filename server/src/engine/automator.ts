import type { LinhaJob, Pessoa } from '../types.ts'

export interface AutomatorDeps {
  getSessao: () => Promise<unknown>
  submeterLinha: (sessao: unknown, p: Pessoa) => Promise<void>
  lerMaiorNumero: (sessao: unknown) => Promise<number>
  log: (msg: string, nivel?: 'info' | 'warn' | 'error') => void
  deveParar?: () => boolean
  onProgress?: (l: LinhaJob) => void
  esperaRetryMs?: number
}

const MAX_TENTATIVAS = 3 // 1 tentativa + 2 retries

export class Automator {
  constructor(private deps: AutomatorDeps) {}

  async start(linhas: LinhaJob[], onProgress: (l: LinhaJob) => void = () => {}): Promise<void> {
    const { submeterLinha, lerMaiorNumero, deveParar, log } = this.deps
    const pendentes = linhas.filter(l => l.status !== 'ok')
    const sessao = await this.deps.getSessao()

    for (const linha of pendentes) {
      if (deveParar?.()) {
        linha.status = 'erro'
        linha.erro = 'Cancelado pelo usuário'
        onProgress(linha)
        break
      }
      linha.status = 'cadastrando'
      onProgress(linha)
      let ok = false
      let ultimoErro = ''
      const n0 = await lerMaiorNumero(sessao).catch(() => 0)
      for (let tent = 0; tent < MAX_TENTATIVAS && !ok; tent++) {
        try {
          for (let k = 0; k < linha.qtd; k++) {
            await submeterLinha(sessao, {
              nome: linha.nome,
              cpf: linha.cpf,
              telefone: linha.telefone,
              email: linha.email,
              qtd: 1,
            })
          }
          const n1 = await lerMaiorNumero(sessao)
          if (n1 >= n0 + linha.qtd || n0 === 0) {
            ok = true
          } else {
            ultimoErro = `Nº não incrementou (${n0}→${n1})`
            log(ultimoErro, 'warn')
          }
        } catch (e) {
          ultimoErro = (e as Error).message
          log(`Tentativa ${tent + 1} falhou: ${ultimoErro}`, 'warn')
          await new Promise(r => setTimeout(r, this.deps.esperaRetryMs ?? 500))
        }
      }
      if (ok) {
        linha.status = 'ok'
        linha.erro = null
      } else {
        linha.status = 'erro'
        linha.erro = ultimoErro
      }
      onProgress(linha)
    }
  }
}