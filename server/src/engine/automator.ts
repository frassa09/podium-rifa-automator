import { linhaLegada } from '../data/banco.ts'
import type { LinhaJob, Pessoa } from '../types.ts'
import type { RifaSite } from '../podium/session.ts'

export interface AutomatorDeps {
  // Lê a tabela de rifas da conta. Deve LANÇAR se a página não for confiável.
  lerRifas: () => Promise<RifaSite[]>
  submeter: (p: Pessoa) => Promise<void>
  // Persiste a linha. É aguardado: se falhar, nada é enviado depois.
  salvar: (l: LinhaJob) => Promise<void>
  log: (msg: string, nivel?: 'info' | 'warn' | 'error') => void
  deveParar?: () => boolean
  // Espera antes de reler quando o envio ainda não apareceu na tabela.
  esperaConfirmacaoMs?: number
}

export class JobAbortado extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'JobAbortado'
  }
}

const contarCpf = (rifas: RifaSite[], cpf: string): number => rifas.filter(r => r.cpf === cpf).length

// Garantias (em ordem de prioridade):
// 1. Nunca mais de `qtd` POSTs por linha, em toda a vida dela: `enviadas` é gravado ANTES de
//    cada POST e o motor nunca envia com `enviadas >= qtd` — vale mesmo se a leitura do site errar.
// 2. Nunca reenviar dentro de uma execução: envio não confirmado na tabela PARA o job.
// 3. Confirmação pela contagem de rifas do CPF na tabela do site (não pelo Nº, que é uma
//    sequência compartilhada com outras contas e não conta rifas).
export class Automator {
  constructor(private deps: AutomatorDeps) {}

  async start(linhas: LinhaJob[]): Promise<void> {
    const { lerRifas, submeter, salvar, log, deveParar } = this.deps
    const espera = this.deps.esperaConfirmacaoMs ?? 3_000
    let totalVisto = -1

    // A tabela do site só cresce. Se encolher, a página não é confiável.
    const ler = async (): Promise<RifaSite[]> => {
      const rifas = await lerRifas()
      if (rifas.length < totalVisto) {
        throw new Error(`tabela do site encolheu (${totalVisto} → ${rifas.length} rifas)`)
      }
      totalVisto = rifas.length
      return rifas
    }

    const abortar = async (linha: LinhaJob, motivo: string): Promise<never> => {
      linha.status = 'erro'
      linha.erro = motivo
      await salvar(linha)
      throw new JobAbortado(`Job parado na linha #${linha.seq} (${linha.nome}): ${motivo}`)
    }

    for (const linha of linhas.filter(l => l.status !== 'ok')) {
      if (deveParar?.()) return

      if (linhaLegada(linha)) {
        linha.status = 'erro'
        linha.erro = 'Linha da versão anterior do app: confira no site quantas rifas existem e, se faltar, crie um novo job só com o que falta.'
        await salvar(linha)
        log(`Linha #${linha.seq} (${linha.nome}) ignorada: criada pela versão anterior`, 'warn')
        continue
      }

      linha.status = 'cadastrando'
      linha.erro = null
      await salvar(linha)

      let rifas: RifaSite[]
      try {
        rifas = await ler()
      } catch (e) {
        return abortar(linha, `não foi possível ler as rifas no site: ${(e as Error).message}`)
      }
      if (linha.base_cpf === null) {
        linha.base_cpf = contarCpf(rifas, linha.cpf)
        await salvar(linha)
      }
      const base = linha.base_cpf

      for (;;) {
        const doCpf = rifas.filter(r => r.cpf === linha.cpf)
        linha.confirmadas = Math.max(0, doCpf.length - base)
        linha.numeros = doCpf.slice(base).map(r => r.numero).join(', ')

        if (linha.confirmadas >= linha.qtd) {
          if (linha.confirmadas > linha.qtd) {
            log(`Linha #${linha.seq}: o site mostra ${linha.confirmadas} rifas novas para ${linha.qtd} pedidas`, 'warn')
          }
          linha.status = 'ok'
          linha.erro = null
          await salvar(linha)
          log(`Linha #${linha.seq} (${linha.nome}) ok: ${linha.numeros}`)
          break
        }

        if (linha.enviadas >= linha.qtd) {
          return abortar(
            linha,
            `${linha.enviadas} envio(s) feitos e só ${linha.confirmadas} confirmado(s) na tabela. Confira no site antes de reprocessar.`
          )
        }
        if (deveParar?.()) {
          linha.status = 'pendente'
          await salvar(linha)
          return
        }

        // Grava o envio ANTES do POST: se o processo cair durante o POST, a retomada já o conta.
        linha.enviadas++
        await salvar(linha)
        const antes = doCpf.length
        try {
          await submeter({ nome: linha.nome, cpf: linha.cpf, telefone: linha.telefone, email: linha.email, qtd: 1 })
        } catch (e) {
          log(`Linha #${linha.seq}: envio retornou erro (${(e as Error).message}); conferindo na tabela`, 'warn')
        }

        let depois = -1
        for (let tentativa = 0; tentativa < 2; tentativa++) {
          if (tentativa > 0) await new Promise(r => setTimeout(r, espera))
          try {
            rifas = await ler()
          } catch (e) {
            return abortar(linha, `envio não confirmado (falha ao ler o site: ${(e as Error).message}). Confira no site antes de reprocessar.`)
          }
          depois = contarCpf(rifas, linha.cpf)
          if (depois > antes) break
        }
        if (depois <= antes) {
          return abortar(linha, 'envio não apareceu na tabela do site. Confira no site antes de reprocessar.')
        }
      }
    }
  }
}
