import { apenasDigitos } from './cpf.ts'

export function maskPhone(phone: string): string {
  const d = apenasDigitos(phone)
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6, 10)}`
  return phone
}
