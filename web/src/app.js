const $ = sel => document.querySelector(sel)

const state = { jobId: null, timer: null, linhas: [] }

function trocarTela(nome) {
  document.querySelectorAll('.tela').forEach(t => (t.hidden = true))
  $(`#tela-${nome}`).hidden = false
  document.querySelectorAll('.tab').forEach(t => {
    t.setAttribute('aria-selected', t.dataset.tela === nome ? 'true' : 'false')
  })
  if (nome === 'progresso') refreshJob()
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => trocarTela(t.dataset.tela))
)

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

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
        body: JSON.stringify({ cpf: $('#cfg-cpf').value, senha: $('#cfg-senha').value }),
      })
      st.className = 'status ok'
      st.textContent = 'Login OK! Turma detectada automaticamente.'
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
  st.className = 'status'
  st.textContent = 'Criando…'
  btn.disabled = true
  try {
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ pessoas: manual }) })
    state.jobId = r.jobId
    st.className = 'status ok'
    st.textContent = `Job #${r.jobId} criado.`
    try {
      await api(`/api/jobs/${r.jobId}/iniciar`, { method: 'POST' })
      st.textContent = `Job #${r.jobId} criado e iniciado.`
    } catch (err) {
      st.className = 'status erro'
      st.textContent = `Job #${r.jobId} criado, mas não iniciou: ${err.message}`
    }
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
  st.textContent = 'Enviando…'
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
    small.textContent = l.status === 'erro' ? l.erro : (l.numeros || '')
    corpo.appendChild(small)
    const status = document.createElement('span')
    status.textContent = l.status
    li.append(dot, corpo, status)
    ul.appendChild(li)
  }
}

async function refreshJob() {
  if (!state.jobId) return
  try {
    const d = await api(`/api/jobs/${state.jobId}`)
    $('#r-total').textContent = d.resumo.total
    $('#r-ok').textContent = d.resumo.ok
    $('#r-erro').textContent = d.resumo.erro
    $('#r-pend').textContent = d.resumo.pendente
    const h = $('#job-header')
    h.textContent = ''
    h.append(`Job #${d.job.id} — status `)
    const b = document.createElement('b')
    b.textContent = d.job.status
    h.appendChild(b)
    h.append(` (criado ${d.job.criado_em})`)
    state.linhas = d.linhas
    renderLinhas()
    const logs = d.logs.join('\n')
    $('#logs').hidden = logs.length === 0
    $('#logs').textContent = logs
  } catch {}
}

$('#btn-iniciar').addEventListener('click', async () => {
  if (!state.jobId) return
  $('#' + 'btn-iniciar').disabled = true
  await api(`/api/jobs/${state.jobId}/iniciar`, { method: 'POST' })
  setTimeout(refreshJob, 300)
})

$('#btn-cancelar').addEventListener('click', async () => {
  if (!state.jobId) return
  await api(`/api/jobs/${state.jobId}/cancelar`, { method: 'POST' })
  setTimeout(refreshJob, 300)
})

$('#btn-reproc').addEventListener('click', async () => {
  if (!state.jobId) return
  await api(`/api/jobs/${state.jobId}/reprocessar-erros`, { method: 'POST' })
  await refreshJob()
})

// Polling 1,5s enquanto na tela progresso
setInterval(() => {
  if (!$('#tela-progresso').hidden && state.jobId) refreshJob()
}, 1500)

// Cache de jobId no hash para sobreviver reload
window.addEventListener('hashchange', () => {
  const m = /#\/job\/(\d+)/.exec(location.hash)
  if (m) { state.jobId = Number(m[1]); trocarTela('progresso') }
})