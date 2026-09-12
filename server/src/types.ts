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
  base: number | null
  enviadas: number
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