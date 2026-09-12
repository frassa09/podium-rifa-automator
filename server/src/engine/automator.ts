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

    for (const linha of pendentes) {
      if (deveParar?.()) {
        linha.status = 'pendente'
        linha.erro = null
        onProgress(linha)
        break
      }
      linha.status = 'cadastrando'
      onProgress(linha)
      let ok = false
      let ultimoErro = ''
      let sessao = await this.deps.getSessao()
      if (linha.base === null) {
        const n0 = await lerMaiorNumero(sessao).catch(() => 0)
        linha.base = n0
        onProgress(linha)
      }
      let restantes = Math.max(linha.qtd - linha.enviadas, 0)
      for (let tent = 0; tent < MAX_TENTATIVAS && !ok; tent++) {
        if (deveParar?.()) break
        try {
          sessao = await this.deps.getSessao()
          for (let k = 0; k < restantes; k++) {
            if (deveParar?.()) break
            await submeterLinha(sessao, {
              nome: linha.nome,
              cpf: linha.cpf,
              telefone: linha.telefone,
              email: linha.email,
              qtd: 1,
            })
            linha.enviadas += 1
            onProgress(linha)
          }
          const n1 = await lerMaiorNumero(sessao)
          if (n1 >= (linha.base ?? 0) + linha.qtd) {
            ok = true
          } else {
            restantes = (linha.base ?? 0) + linha.qtd - n1
            ultimoErro = `Nº não incrementou (${linha.base}→${n1})`
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
      } else if (deveParar?.()) {
        linha.status = 'pendente'
        linha.erro = null
      } else {
        linha.status = 'erro'
        linha.erro = ultimoErro
      }
      onProgress(linha)
    }
  }
}