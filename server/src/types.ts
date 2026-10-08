export interface Pessoa {
  nome: string
  cpf: string
  telefone: string
  email: string
  qtd: number
}

export type StatusLinha = 'pendente' | 'cadastrando' | 'ok' | 'erro'

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
  // Legado (versão que media pelo Nº). Não é mais escrito; só identifica linhas antigas.
  base: number | null
  // Quantas rifas este CPF já tinha no site antes da linha começar (medido uma vez, persistido).
  base_cpf: number | null
  // POSTs já disparados para a linha. Gravado ANTES de cada POST; nunca passa de qtd.
  enviadas: number
  // Rifas da linha confirmadas na tabela do site (contagem do CPF − base_cpf).
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
  pendente: number
  ativo: boolean
}