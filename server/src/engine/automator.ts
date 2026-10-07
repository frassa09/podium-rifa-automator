import type { LinhaJob, Pessoa } from '../types.ts'
import type { RespostaRegistro } from '../podium/session.ts'

export interface AutomatorDeps {
  getSessao: () => Promise<unknown>
  // Exatamente um POST. Erro ou resposta estranha não decidem nada: a medição decide.
  submeterLinha: (sessao: unknown, p: Pessoa) => Promise<RespostaRegistro | void>
  // Rifas deste CPF na tabela completa do site. Deve lançar se não conseguir ler tudo.
  contarRifasDoCpf: (sessao: unknown, cpf: string) => Promise<number>
  // Persistência síncrona (await). Se falhar, o job para antes do próximo POST.
  salvarLinha: (l: LinhaJob) => Promise<void>
  log: (msg: string, nivel?: 'info' | 'warn' | 'error') => void
  deveParar?: () => boolean
}

export class JobAbortado extends Error {
  constructor(msg: string) {
    super(`Abortando job: ${msg}`)
    this.name = 'JobAbortado'
  }
}

// Contrato at-most-once (spec 2026-10-07 §2.2): cada POST é registrado ANTES de sair
// (`tentativas`) e só acontece depois de provado, pela contagem do CPF no site, que todos
// os anteriores foram contabilizados. Na dúvida a linha vira `incerto` e o job para.
// Uma linha nunca recebe mais que `qtd` POSTs.
export class Automator {
  constructor(private deps: AutomatorDeps) {}

  async start(linhas: LinhaJob[]): Promise<void> {
    for (const linha of linhas) {
      if (linha.status === 'ok') continue
      if (linha.status === 'incerto') {
        this.deps.log(`Linha #${linha.id} está incerta: aguardando conferência humana, não será enviada`, 'warn')
        continue
      }
      if (this.deps.deveParar?.()) return
      await this.processar(linha)
    }
  }

  private async processar(l: LinhaJob): Promise<void> {
    const { getSessao, submeterLinha, contarRifasDoCpf, salvarLinha, log, deveParar } = this.deps

    const salvar = async (patch: Partial<LinhaJob>): Promise<void> => {
      Object.assign(l, patch)
      await salvarLinha(l)
    }
    const parar = async (status: 'erro' | 'incerto', erro: string): Promise<never> => {
      await salvar({ status, erro })
      throw new JobAbortado(`linha #${l.id} ${status}: ${erro}`)
    }
    const medir = async (): Promise<number> => {
      try {
        return await contarRifasDoCpf(await getSessao(), l.cpf)
      } catch (e) {
        // Sem envio pendente de confirmação nada foi perdido (erro); com envio pendente, incerto.
        return parar(l.tentativas > l.confirmadas ? 'incerto' : 'erro', `não foi possível contar as rifas do CPF no site: ${(e as Error).message}`)
      }
    }

    await salvar({ status: 'cadastrando', erro: null })

    if (l.base_cpf === null) {
      if (l.tentativas > 0) return parar('incerto', 'há envios registrados sem contagem base do CPF')
      await salvar({ base_cpf: await medir() })
    }
    const base = l.base_cpf!

    for (;;) {
      const atual = await medir()
      const confirmadas = atual - base
      if (confirmadas < 0) {
        return parar('incerto', `site mostra ${atual} rifa(s) do CPF, menos que a base ${base}`)
      }
      await salvar({ confirmadas, enviadas: Math.min(confirmadas, l.qtd) })

      if (confirmadas >= l.qtd) {
        if (confirmadas > l.qtd) log(`Linha #${l.id}: ${confirmadas} rifa(s) confirmada(s) para qtd ${l.qtd}`, 'warn')
        await salvar({ status: 'ok', erro: null })
        return
      }
      if (l.tentativas > confirmadas) {
        return parar('incerto', `${l.tentativas} envio(s) e ${confirmadas} confirmado(s) no site; confira antes de reenviar`)
      }
      if (deveParar?.()) {
        await salvar({ status: 'pendente', erro: null })
        return
      }

      await salvar({ tentativas: l.tentativas + 1 })
      try {
        const r = await submeterLinha(await getSessao(), { nome: l.nome, cpf: l.cpf, telefone: l.telefone, email: l.email, qtd: 1 })
        if (r && !(r.status === 302 && /form_rifa/.test(r.location))) {
          log(`Linha #${l.id}: resposta inesperada do registro (${r.status} ${r.location}); medindo antes de decidir`, 'warn')
        }
      } catch (e) {
        log(`Linha #${l.id}: envio falhou (${(e as Error).message}); medindo antes de decidir`, 'warn')
      }
    }
  }
}
