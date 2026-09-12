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
      avisos.innerHTML = '<strong>Linhas com erro (não importadas):</strong><ul>' +
        invalidas.map(i => `<li>${i.pessoa?.nome || '(sem nome)'} — ${i.erros.join(', ')}</li>`).join('') +
        '</ul>'
    }
  }
})

// ————— Progresso —————
function renderLinhas() {
  const ul = $('#linhas')
  ul.innerHTML = ''
  for (const l of state.linhas) {
    const li = document.createElement('li')
    const texto = `${l.nome}<br><small>${l.status === 'erro' ? l.erro : (l.numeros || '')}</small>`
    li.innerHTML = `<span class="st ${l.status}"></span><span>${texto}</span><span>${l.status}</span>`
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
    $('#job-header').innerHTML =
      `Job #${d.job.id} — status <b>${d.job.status}</b> (criado ${d.job.criado_em})`
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