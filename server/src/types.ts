export interface Pessoa {
  nome: string
  cpf: string
  telefone: string
  email: string
  qtd: number
}

// incerto: houve envio sem confirmação no site; só um humano decide (spec 2026-10-07 §2.2/§2.3).
export type StatusLinha = 'pendente' | 'cadastrando' | 'ok' | 'erro' | 'incerto'

export interface LinhaJob {
  id: number
  job_id: number
  seq: number
  nome: string
  cpf: string
  telefone: string
  email: string
  qtd: number
  status: StatusLinha
  erro: string | null
  numeros: string
  base: number | null
  enviadas: number
  // Write-ahead log por envio (§2.2): rifas do CPF no site antes do 1º envio,
  // POSTs gravados (antes de enviar) e rifas confirmadas por medição.
  base_cpf: number | null
  tentativas: number
  confirmadas: number
}

export type StatusJob = 'pendente' | 'rodando' | 'concluido' | 'pausado' | 'cancelado'

export interface Config {
  cpf: string
  senha: string
  turma: string
}

export interface ResumoProgresso {
  total: number
  ok: number
  erro: number
  incerto: number
  pendente: number
  ativo: boolean
}