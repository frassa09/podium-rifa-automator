export function apenasDigitos(v: string): string {
  return v.replace(/\D/g, '')
}

export function validarCPF(cpf: string): boolean {
  const d = apenasDigitos(cpf)
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false

  const calc = (len: number): number => {
    let sum = 0
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i)
    const rest = (sum * 10) % 11
    return rest === 10 ? 0 : rest
  }

  if (Number(d[9]) !== calc(9)) return false
  if (Number(d[10]) !== calc(10)) return false
  return true
}

export function maskCPF(cpf: string): string {
  const d = apenasDigitos(cpf)
  if (d.length !== 11) return cpf
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`
}
