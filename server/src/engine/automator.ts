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

const MAX_TENTATIVAS = 3 // tentativas seguidas sem avanço confirmado no site

export class Automator {
  constructor(private deps: AutomatorDeps) {}

  async start(linhas: LinhaJob[], onProgress: (l: LinhaJob) => void = () => {}): Promise<void> {
    const { submeterLinha, lerMaiorNumero, deveParar, log, esperaRetryMs } = this.deps
    const pendentes = linhas.filter(l => l.status !== 'ok')

    for (const linha of pendentes) {
      if (deveParar?.()) {
        linha.status = 'pendente'
        linha.erro = null
        onProgress(linha)
        break
      }
      linha.status = 'cadastrando'
      linha.erro = null
      onProgress(linha)

      let sessao = await this.deps.getSessao()
      if (linha.base === null) {
        const n0 = await lerMaiorNumero(sessao).catch(() => 0)
        linha.base = n0
        onProgress(linha)
      }
      const qtd = linha.qtd
      const alvo = linha.base + qtd
      let ultimoErro = ''
      let falhasSemAvanco = 0
      let concluido = false

      // Regra de ouro: o Nº do site é a única verdade. Nunca re-submeter uma rifa
      // sem antes CONFIRMAR (medindo) que ela não foi criada. Se a medição falhar
      // depois de submeter, a linha é marcada como 'não confirmada' e o job é
      // abortado — nunca se cria no escuro.
      while (!concluido) {
        if (deveParar?.()) {
          linha.status = 'pendente'
          linha.erro = null
          onProgress(linha)
          return
        }
        sessao = await this.deps.getSessao()
        let n0: number
        try {
          n0 = await lerMaiorNumero(sessao)
        } catch (e) {
          linha.status = 'erro'
          linha.erro = `não foi possível medir o Nº atual: ${(e as Error).message}`
          onProgress(linha)
          throw new Error(`Abortando job: ${linha.erro}`)
        }
        const faltando = alvo - n0
        if (faltando <= 0) {
          concluido = true
          break
        }
        try {
          sessao = await this.deps.getSessao()
          await submeterLinha(sessao, {
            nome: linha.nome,
            cpf: linha.cpf,
            telefone: linha.telefone,
            email: linha.email,
            qtd: 1,
          })
        } catch (e) {
          ultimoErro = (e as Error).message
          log(`Submissão falhou: ${ultimoErro}`, 'warn')
        }
        let nDepois: number
        try {
          sessao = await this.deps.getSessao()
          nDepois = await lerMaiorNumero(sessao)
        } catch (e) {
          linha.status = 'erro'
          linha.erro = `submissão não confirmada (verifique o site manualmente): ${(e as Error).message}`
          onProgress(linha)
          throw new Error(`Abortando job: ${linha.erro}`)
        }
        const criadas = nDepois - n0
        if (criadas >= faltando) {
          concluido = true
          if (criadas > faltando) {
            log(`Linha #${linha.id} registrou mais rifas que o esperado (${criadas} por cima de ${faltando} faltando)`, 'warn')
          }
        } else if (criadas > 0) {
          falhasSemAvanco = 0
          linha.enviadas = Math.min(linha.enviadas + criadas, qtd)
          onProgress(linha)
        } else {
          falhasSemAvanco++
          ultimoErro = `site não registrou a submissão (Nº ${n0}→${nDepois})`
          log(ultimoErro, 'warn')
          if (falhasSemAvanco >= MAX_TENTATIVAS) break
          await new Promise(r => setTimeout(r, esperaRetryMs ?? 500))
        }
      }

      if (concluido) {
        linha.status = 'ok'
        linha.erro = null
        linha.enviadas = qtd
      } else {
        linha.status = 'erro'
        linha.erro = ultimoErro || 'falha sem avanço confirmado no site'
      }
      onProgress(linha)
    }
  }
}