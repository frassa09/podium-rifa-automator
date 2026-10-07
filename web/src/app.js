const $ = sel => document.querySelector(sel)

const state = { jobId: null, timer: null, linhas: [], conferencia: {} }
let pin = sessionStorage.getItem('pin') || ''

function trocarTela(nome) {
  document.querySelectorAll('.tela').forEach(t => (t.hidden = true))
  $(`#tela-${nome}`).hidden = false
  document.querySelectorAll('.tab').forEach(t => {
    t.setAttribute('aria-selected', t.dataset.tela === nome ? 'true' : 'false')
  })
  if (nome === 'progresso') refreshJob()
  if (nome === 'historico') refreshHistorico()
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => trocarTela(t.dataset.tela))
)

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(pin ? { 'X-PIN': pin } : {}),
    },
    ...opts,
  })
  if (r.status === 401) {
    trocarTela('pin')
    throw new Error('PIN necessário')
  }
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function refreshLoginBadge() {
  const b = $('#login-badge')
  try {
    const c = await api('/api/config')
    b.hidden = false
    if (c.configurado) {
      b.className = 'login-badge ok'
      b.textContent = c.viaAmbiente
        ? `Conta via ambiente: ${maskCPF(c.cpf)}${c.turma ? ` · Turma ${c.turma}` : ''}`
        : c.turma
          ? `Conta ativa: ${maskCPF(c.cpf)} · Turma ${c.turma}`
          : `Conta ativa: ${maskCPF(c.cpf)}`
    } else {
      b.className = 'login-badge nao'
      b.textContent = `Nenhuma conta configurada — use a aba Login (limite ${c.maxQuantidade ?? 100}/pessoa)`
    }
  } catch {
    b.hidden = true
  }
}

async function initBoot() {
  try {
    const c = await api('/api/config')
    $('#m-qtd').max = c.maxQuantidade ?? 100
    if (c.viaAmbiente) {
      $('#env-aviso').hidden = false
      $('#form-config').hidden = true
      $('#env-limite').textContent = `Limite por pessoa: ${c.maxQuantidade ?? 100} rifas.`
    } else {
      $('#env-aviso').hidden = true
      $('#form-config').hidden = false
    }
  } catch {}
  refreshLoginBadge()
}
initBoot()

// (————————) PIN ———————
$('#btn-pin').addEventListener('click', async () => {
  const st = $('#pin-status')
  const valor = $('#pin').value.trim()
  if (!valor) {
    st.className = 'status'
    st.textContent = 'Digite o PIN.'
    return
  }
  const r = await fetch('/api/config', { headers: { 'X-PIN': valor } })
  if (r.ok) {
    pin = valor
    sessionStorage.setItem('pin', valor)
    $('#pin').value = ''
    $('#pin-status').textContent = ''
    trocarTela('manual')
    refreshLoginBadge()
  } else {
    st.className = 'status erro'
    st.textContent = r.status === 429 ? ((await r.json().catch(() => null))?.erro ?? 'Muitas tentativas.') : 'PIN inválido.'
  }
})

// ————— Configuração —————
$('#form-config').addEventListener('submit', async e => {
  e.preventDefault()
  const st = $('#cfg-status')
  st.className = 'status'
  st.textContent = 'Testando…'
  try {
    const r = await api('/api/test-login', {
      method: 'POST',
      body: JSON.stringify({ cpf: $('#cfg-cpf').value, senha: $('#cfg-senha').value }),
    })
    if (r.ok) {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ cpf: $('#cfg-cpf').value, senha: $('#cfg-senha').value, turma: r.turma }),
      })
      st.className = 'status ok'
      st.textContent = 'Login OK! Turma detectada automaticamente.'
      refreshLoginBadge()
    } else {
      st.className = 'status erro'
      st.textContent = r.erro
    }
  } catch (err) {
    st.className = 'status erro'
    st.textContent = 'Erro de rede: ' + err.message
  }
})

// ————— Manual —————
let manual = []
const $m = id => $(id).value

function maskCPF(v) {
  const d = v.replace(/\D/g, '')
  return (
    d.slice(0, 3) +
    (d.length > 3 ? '.' : '') +
    d.slice(3, 6) +
    (d.length > 6 ? '.' : '') +
    d.slice(6, 9) +
    (d.length > 9 ? '-' : '') +
    d.slice(9, 11)
  )
}

function maskTel(v) {
  const d = v.replace(/\D/g, '')
  let r = ''
  if (d.length) r += '(' + d.slice(0, 2)
  if (d.length > 2) r += ') ' + d.slice(2, 7)
  if (d.length > 7) r += '-' + d.slice(7, 11)
  return r
}

$('#m-cpf').addEventListener('input', e => (e.target.value = maskCPF(e.target.value)))
$('#m-tel').addEventListener('input', e => (e.target.value = maskTel(e.target.value)))

function validarManual() {
  const erros = []
  if (!$m('#m-nome').trim()) erros.push('Nome obrigatório')
  if (maskCPF($m('#m-cpf')).replace(/\D/g, '').length !== 11) erros.push('CPF com 11 dígitos')
  if ($m('#m-tel').replace(/\D/g, '').length < 10) erros.push('Telefone incompleto')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test($m('#m-email'))) erros.push('E-mail inválido')
  const qtd = Number($m('#m-qtd'))
  if (!Number.isInteger(qtd) || qtd < 1) erros.push('Rifas deve ser inteiro ≥ 1')
  return erros
}

function renderManual() {
  const ul = $('#m-lista')
  ul.textContent = ''
  let total = 0
  manual.forEach((p, i) => {
    const li = document.createElement('li')
    const dot = document.createElement('span')
    dot.className = 'st ok'
    const corpo = document.createElement('span')
    corpo.textContent = p.nome
    corpo.appendChild(document.createElement('br'))
    const small = document.createElement('small')
    small.textContent = `${p.cpf} · ${p.qtd} rifa(s)`
    corpo.appendChild(small)
    const rem = document.createElement('button')
    rem.className = 'btn btn-mini'
    rem.textContent = 'remover'
    rem.addEventListener('click', () => {
      manual.splice(i, 1)
      renderManual()
    })
    li.append(dot, corpo, rem)
    ul.appendChild(li)
    total += p.qtd
  })
  $('#m-total').textContent = total ? `— ${total} rifa(s)` : ''
  $('#btn-criar').disabled = manual.length === 0
}

$('#form-manual').addEventListener('submit', e => {
  e.preventDefault()
  const st = $('#m-status')
  const erros = validarManual()
  if (erros.length) {
    st.className = 'status erro'
    st.textContent = erros.join(' · ')
    return
  }
  manual.push({
    nome: $m('#m-nome').trim(),
    cpf: maskCPF($m('#m-cpf')),
    telefone: $m('#m-tel'),
    email: $m('#m-email').trim(),
    qtd: Number($m('#m-qtd')),
  })
  renderManual()
  e.target.reset()
  $('#m-qtd').value = 1
  st.className = 'status ok'
  st.textContent = 'Adicionado.'
})

$('#btn-limpar').addEventListener('click', () => {
  manual = []
  renderManual()
  $('#m-status').textContent = ''
})

$('#btn-criar').addEventListener('click', async () => {
  const st = $('#m-criar-status')
  const btn = $('#btn-criar')
  const total = manual.reduce((s, p) => s + p.qtd, 0)
  if (!confirm(`Serão criadas ${total} rifa(s) para ${manual.length} pessoa(s). Confirmar?`)) return
  st.className = 'status'
  st.textContent = 'Criando…'
  btn.disabled = true
  try {
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ pessoas: manual }) })
    state.jobId = r.jobId
    st.className = 'status ok'
    st.textContent = `Job #${r.jobId} criado — nenhuma rifa foi enviada. Inicie em Progresso.`
    manual = []
    renderManual()
    setTimeout(() => trocarTela('progresso'), 500)
  } catch (err) {
    let msg = err.message
    try { const j = JSON.parse(err.message.substring(err.message.indexOf('{')))
      msg = j.invalidas?.length ? `${j.invalidas.length} pessoa(s) inválida(s)` : j.erro ?? msg
    } catch {}
    st.className = 'status erro'
    st.textContent = 'Erro: ' + msg
    btn.disabled = false
  }
})

// ————— Importar —————
$('#btn-importar').addEventListener('click', async () => {
  const st = $('#import-status')
  st.className = 'status'
  st.textContent = 'Validando…'
  const avisos = $('#avisos')
  avisos.hidden = true
  const arq = $('#arq').files[0]
  let body
  if (arq) {
    const buf = await arq.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
    body = { arquivo: base64, nomeArquivo: arq.name }
  } else {
    body = { texto: $('#colar').value }
  }
  try {
    const prev = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ ...body, semCriar: true }) })
    if (!prev.preview) throw new Error('resposta inesperada')
    if (!confirm(`Serão criadas ${prev.totalRifas} rifa(s) de ${prev.linhas} pessoa(s). Confirmar importação?`)) {
      st.textContent = ''
      return
    }
    st.textContent = 'Criando…'
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) })
    state.jobId = r.jobId
    st.className = 'status ok'
    st.textContent = `Job #${r.jobId} criado. Vá em Progresso.`
    trocarTela('progresso')
  } catch (err) {
    let msg = err.message
    let invalidas = []
    try { const j = JSON.parse(err.message.substring(err.message.indexOf('{')))
      invalidas = j.invalidas || [] } catch {}
    st.className = 'status erro'
    st.textContent = invalidas.length ? `${invalidas.length} linha(s) inválida(s)` : msg
    if (invalidas.length) {
      avisos.hidden = false
      avisos.innerHTML = ''
      const strong = document.createElement('strong')
      strong.textContent = 'Linhas com erro (não importadas):'
      avisos.appendChild(strong)
      const ul = document.createElement('ul')
      for (const i of invalidas) {
        const li = document.createElement('li')
        li.textContent = `${i.pessoa?.nome || '(sem nome)'} — ${i.erros.join(', ')}`
        ul.appendChild(li)
      }
      avisos.appendChild(ul)
    }
  }
})

// ————— Progresso —————
function renderLinhas() {
  const ul = $('#linhas')
  ul.innerHTML = ''
  for (const l of state.linhas) {
    const li = document.createElement('li')
    const dot = document.createElement('span')
    dot.className = `st ${l.status}`
    const corpo = document.createElement('span')
    corpo.textContent = l.nome
    corpo.appendChild(document.createElement('br'))
    const small = document.createElement('small')
    small.textContent = l.status === 'erro' || l.status === 'incerto' ? l.erro : (l.numeros || '')
    corpo.appendChild(small)
    const conf = state.conferencia[l.id]
    if (conf) {
      const c = document.createElement('small')
      c.className = 'conferencia'
      c.textContent = conf.desdeBase === null
        ? `Site: ${conf.site} rifa(s) deste CPF (linha ainda sem base)`
        : `Site: ${conf.desdeBase} de ${conf.qtd} desde a base · ${conf.tentativas} envio(s) registrado(s)`
      corpo.appendChild(document.createElement('br'))
      corpo.appendChild(c)
    }
    const status = document.createElement('span')
    status.textContent = l.status === 'incerto' ? 'incerto — conferir no site' : l.status
    li.append(dot, corpo, status)
    if (l.status === 'incerto') li.appendChild(acoesIncerta(l))
    ul.appendChild(li)
  }
}

function msgErro(e) {
  try { return JSON.parse(e.message).erro || e.message } catch { return e.message }
}

function avisoResolver(texto, ok) {
  const st = $('#resolver-status')
  st.hidden = false
  st.className = `status ${ok ? 'ok' : 'erro'}`
  st.textContent = texto
}

// Linha incerta: houve envio sem confirmação. Só um humano decide, depois de conferir no site.
function acoesIncerta(l) {
  const div = document.createElement('div')
  div.className = 'acoes'
  const ok = document.createElement('button')
  ok.className = 'btn btn-mini'
  ok.textContent = 'Marcar ok'
  ok.addEventListener('click', async () => {
    if (!confirm(`Confirma que ${l.nome} já tem as ${l.qtd} rifa(s) no site? A linha vira ok e nada mais será enviado.`)) return
    try {
      await api(`/api/linhas/${l.id}/resolver`, { method: 'POST', body: JSON.stringify({ acao: 'marcar_ok' }) })
      avisoResolver(`Linha de ${l.nome} marcada como ok.`, true)
    } catch (e) { avisoResolver(msgErro(e), false) }
    await refreshJob()
  })
  const reenviar = document.createElement('button')
  reenviar.className = 'btn btn-mini'
  reenviar.textContent = 'Liberar reenvio'
  reenviar.addEventListener('click', async () => {
    if (!confirm(`O servidor vai contar no site as rifas de ${l.nome} e só libera se faltar alguma. Continuar?`)) return
    try {
      const r = await api(`/api/linhas/${l.id}/resolver`, { method: 'POST', body: JSON.stringify({ acao: 'liberar_reenvio' }) })
      avisoResolver(`Liberado: ${r.confirmadas} confirmada(s) no site, faltam ${r.faltam}. Toque em Iniciar para enviar.`, true)
    } catch (e) { avisoResolver(msgErro(e), false) }
    await refreshJob()
  })
  div.append(ok, reenviar)
  return div
}

async function refreshJob() {
  if (!state.jobId) return
  try {
    const d = await api(`/api/jobs/${state.jobId}`)
    $('#r-total').textContent = d.resumo.total
    $('#r-ok').textContent = d.resumo.ok
    $('#r-erro').textContent = d.resumo.erro
    $('#r-incerto').textContent = d.resumo.incerto ?? 0
    $('#r-pend').textContent = d.resumo.pendente
    const h = $('#job-header')
    h.textContent = ''
    h.append(`Job #${d.job.id} — status `)
    const b = document.createElement('b')
    b.textContent = d.job.status
    h.appendChild(b)
    h.append(` (criado ${d.job.criado_em})`)
    if (state.conferenciaDe !== d.job.id) state.conferencia = {}
    state.linhas = d.linhas
    renderLinhas()
    const logs = d.logs.join('\n')
    $('#logs').hidden = logs.length === 0
    $('#logs').textContent = logs
  } catch {}
}

$('#btn-iniciar').addEventListener('click', async () => {
  if (!state.jobId) return
  const pendentes = state.linhas
    .filter(l => l.status !== 'ok')
    .reduce((s, l) => s + Math.max(0, l.qtd - l.enviadas), 0)
  if (!confirm(`Faltam criar ${pendentes} rifa(s). Confirmar início?`)) return
  $('#btn-iniciar').disabled = true
  await api(`/api/jobs/${state.jobId}/iniciar`, { method: 'POST' })
  setTimeout(refreshJob, 300)
})

$('#btn-cancelar').addEventListener('click', async () => {
  if (!state.jobId) return
  await api(`/api/jobs/${state.jobId}/cancelar`, { method: 'POST' })
  setTimeout(refreshJob, 300)
})

$('#btn-conferir').addEventListener('click', async () => {
  if (!state.jobId) return
  const b = $('#btn-conferir')
  b.disabled = true
  try {
    const r = await api(`/api/jobs/${state.jobId}/conferencia`)
    state.conferencia = Object.fromEntries(r.linhas.map(l => [l.id, l]))
    state.conferenciaDe = state.jobId
    avisoResolver('Conferência feita com o site agora.', true)
    renderLinhas()
  } catch (e) { avisoResolver(msgErro(e), false) }
  b.disabled = false
})

$('#btn-reproc').addEventListener('click', async () => {
  if (!state.jobId) return
  await api(`/api/jobs/${state.jobId}/reprocessar-erros`, { method: 'POST' })
  await refreshJob()
})

// ————— Histórico —————
async function refreshHistorico() {
  const ul = $('#historico-lista')
  ul.textContent = ''
  try {
    const jobs = await api('/api/jobs')
    for (const j of jobs) {
      const li = document.createElement('li')
      const dot = document.createElement('span')
      dot.className = `st ${j.status === 'rodando' ? 'cadastrando' : j.status}`
      const info = document.createElement('span')
      info.textContent = `#${j.id} — ${j.status} — ${j.ok} ok / ${j.erro} erro (${j.total} linhas) · ${j.criado_em}`
      const abrir = document.createElement('button')
      abrir.className = 'btn btn-mini'
      abrir.textContent = 'Abrir'
      abrir.addEventListener('click', () => {
        state.jobId = j.id
        trocarTela('progresso')
      })
      const reproc = document.createElement('button')
      reproc.className = 'btn btn-mini'
      reproc.textContent = 'Reprocessar erros'
      reproc.addEventListener('click', async () => {
        await api(`/api/jobs/${j.id}/reprocessar-erros`, { method: 'POST' })
        await refreshHistorico()
      })
      li.append(dot, info, abrir, reproc)
      ul.appendChild(li)
    }
  } catch {}
}

// Polling 1,5s enquanto na tela progresso
setInterval(() => {
  if (!$('#tela-progresso').hidden && state.jobId) refreshJob()
}, 1500)

// Cache de jobId no hash para sobreviver reload
window.addEventListener('hashchange', () => {
  const m = /#\/job\/(\d+)/.exec(location.hash)
  if (m) { state.jobId = Number(m[1]); trocarTela('progresso') }
})