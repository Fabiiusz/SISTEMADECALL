// Painel lateral: exibe o estado do copiloto e controla início/parada.
// Todo o processamento acontece no offscreen document; aqui só renderizamos.

import { getSettings } from '../shared/settings.js';
import { loadPlaybook } from '../shared/playbook.js';

const el = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  toggleBtn: document.getElementById('toggleBtn'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('bannerText'),
  bannerAction: document.getElementById('bannerAction'),
  bannerClose: document.getElementById('bannerClose'),
  objectionCard: document.getElementById('objectionCard'),
  objectionType: document.getElementById('objectionType'),
  objectionAnswer: document.getElementById('objectionAnswer'),
  copyObjection: document.getElementById('copyObjection'),
  dismissObjection: document.getElementById('dismissObjection'),
  stages: document.getElementById('stages'),
  stageDesc: document.getElementById('stageDesc'),
  nextQuestion: document.getElementById('nextQuestion'),
  checklist: document.getElementById('checklist'),
  checklistCounter: document.getElementById('checklistCounter'),
  transcript: document.getElementById('transcript'),
  transcriptEmpty: document.getElementById('transcriptEmpty'),
  transcriptDetails: document.getElementById('transcriptDetails'),
  levelLead: document.getElementById('levelLead'),
  levelSeller: document.getElementById('levelSeller'),
  playbookName: document.getElementById('playbookName'),
  openOptions: document.getElementById('openOptions'),
};

const ui = {
  running: false,
  busy: false,
  playbook: null,
  analysis: null,
  partialNodes: { LEAD: null, VENDEDOR: null },
  dismissedObjectionTs: null,
};

init();

async function init() {
  el.toggleBtn.addEventListener('click', onToggle);
  el.bannerClose.addEventListener('click', hideBanner);
  el.openOptions.addEventListener('click', (e) => { e.preventDefault(); openOptions(); });
  el.dismissObjection.addEventListener('click', dismissObjection);
  el.copyObjection.addEventListener('click', copyObjection);
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.playbookOverride && !ui.running) loadAndRenderPlaybook();
  });

  await loadAndRenderPlaybook();
  await restoreFromOffscreen();
  await refreshContext();
}

// A mensagem 'invoked' pode chegar antes do painel terminar de carregar, então
// ao abrir perguntamos o estado direto ao service worker.
async function refreshContext() {
  if (ui.running) return;
  try {
    const res = await chrome.runtime.sendMessage({ target: 'background', type: 'copilot:getContext' });
    if (res?.ok) {
      el.statusText.textContent = res.isMeet
        ? 'Aba do Meet liberada. Clique em Iniciar copiloto.'
        : 'Abra a aba do Meet e clique no ícone da extensão nela.';
    }
  } catch (err) {
    console.warn('getContext', err);
  }
}

async function loadAndRenderPlaybook() {
  try {
    const { playbook, origem } = await loadPlaybook();
    ui.playbook = playbook;
    el.playbookName.textContent = `${playbook.nome || 'Playbook'} (${origem === 'personalizado' ? 'personalizado' : 'playbook.json'})`;
    if (!ui.analysis) renderAnalysis(null);
  } catch (err) {
    showBanner('Erro ao carregar o playbook: ' + err.message);
  }
}

async function restoreFromOffscreen() {
  try {
    const state = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:getState' });
    if (!state || !state.running) { setRunning(false); return; }
    if (state.playbook) ui.playbook = state.playbook;
    setRunning(true);
    renderStatus(state.status);
    el.transcript.querySelectorAll('.line').forEach((n) => n.remove());
    for (const line of state.transcript || []) appendLine(line);
    for (const speaker of ['LEAD', 'VENDEDOR']) renderPartial(speaker, state.partial?.[speaker] || '');
    renderAnalysis(state.analysis);
  } catch {
    // Offscreen não existe: copiloto parado.
    setRunning(false);
  }
}

// ---------- Ações ----------

async function onToggle() {
  if (ui.busy) return;
  if (ui.running) await stopCopilot();
  else await startCopilot();
}

async function startCopilot() {
  hideBanner();
  const settings = await getSettings();
  if (!settings.apiKey) {
    showBanner('Cole a sua chave da API do Gemini nas opções antes de iniciar.', { label: 'Abrir opções', onClick: openOptions });
    return;
  }

  setBusy(true, 'Verificando microfone...');
  const micOk = await ensureMicPermission();
  if (!micOk) { setBusy(false); return; }

  setBusy(true, 'Iniciando...');
  try {
    const res = await chrome.runtime.sendMessage({ target: 'background', type: 'copilot:start' });
    if (!res || !res.ok) {
      handleStartError(res);
      setRunning(false);
      return;
    }
    el.transcript.querySelectorAll('.line').forEach((n) => n.remove());
    if (res.playbook) ui.playbook = res.playbook;
    setRunning(true);
    renderStatus(res.status || { state: 'connecting', message: 'Conectando à Gemini...' });
    renderAnalysis(res.analysis);
  } catch (err) {
    showBanner('Falha ao iniciar: ' + (err?.message || err));
    setRunning(false);
  } finally {
    setBusy(false);
  }
}

function handleStartError(res) {
  const message = res?.error || 'Não foi possível iniciar o copiloto.';
  if (res?.code === 'NO_API_KEY') {
    showBanner(message, { label: 'Abrir opções', onClick: openOptions });
  } else if (res?.code === 'MIC_DENIED') {
    showBanner(message, { label: 'Conceder microfone', onClick: openPermissionPage });
  } else if (res?.code === 'NEEDS_INVOKE' || res?.code === 'NO_MEET_TAB') {
    // Só o clique no ícone da extensão concede activeTab. Não existe botão no
    // painel capaz de substituir esse gesto, então instruímos o usuário.
    showBanner(message, null, 'info');
  } else {
    showBanner(message);
  }
  renderStatus({ state: 'error', message: 'Falha ao iniciar' });
}

async function stopCopilot() {
  setBusy(true, 'Parando...');
  try {
    await chrome.runtime.sendMessage({ target: 'background', type: 'copilot:stop' });
  } catch (err) {
    console.warn(err);
  } finally {
    setBusy(false);
    setRunning(false);
    renderStatus({ state: 'idle', message: 'Copiloto parado' });
    setLevel('LEAD', 0); setLevel('VENDEDOR', 0);
  }
}

async function ensureMicPermission() {
  let state = 'prompt';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    state = status.state;
  } catch { /* navegador sem suporte à consulta */ }
  if (state === 'granted') return true;
  if (state === 'denied') {
    showBanner('O microfone está bloqueado para esta extensão. Libere a permissão e tente de novo.', { label: 'Como liberar', onClick: openPermissionPage });
    return false;
  }
  // Tenta pedir a permissão a partir do próprio painel; se o Chrome não mostrar
  // o pedido aqui, abre uma página dedicada.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      showBanner('Nenhum microfone foi encontrado neste computador.');
      return false;
    }
    showBanner('Precisamos da permissão do microfone para ouvir a sua voz. Conceda na página que vai abrir e clique em Iniciar de novo.', { label: 'Conceder microfone', onClick: openPermissionPage });
    return false;
  }
}

function openOptions() {
  chrome.runtime.sendMessage({ target: 'background', type: 'copilot:openOptions' }).catch(() => chrome.runtime.openOptionsPage());
}
function openPermissionPage() {
  chrome.runtime.sendMessage({ target: 'background', type: 'copilot:openPermissionPage' }).catch(console.warn);
}

function dismissObjection() {
  if (ui.analysis?.objecao_detectada) ui.dismissedObjectionTs = ui.analysis.objecao_detectada.ts || 0;
  el.objectionCard.hidden = true;
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:dismissObjection' }).catch(() => {});
}

async function copyObjection() {
  try {
    await navigator.clipboard.writeText(el.objectionAnswer.textContent);
    el.copyObjection.textContent = '✓';
    setTimeout(() => { el.copyObjection.textContent = '⧉'; }, 1200);
  } catch { /* ignore */ }
}

// ---------- Mensagens do offscreen ----------

function onMessage(msg) {
  if (!msg || msg.target !== 'sidepanel') return;
  switch (msg.type) {
    case 'status':
      if (typeof msg.running === 'boolean' && msg.running !== ui.running) setRunning(msg.running);
      renderStatus(msg.status);
      if (msg.status?.state === 'error') showBanner(msg.status.message || 'Erro no copiloto.');
      break;
    case 'transcript':
      appendLine(msg.line);
      break;
    case 'partial':
      renderPartial(msg.speaker, msg.text);
      break;
    case 'level':
      setLevel(msg.speaker, msg.level);
      break;
    case 'analysis':
      renderAnalysis(msg.analysis);
      break;
    case 'analyzing':
      el.checklistCounter.classList.toggle('pulse', !!msg.value);
      break;
    case 'analysisError':
      showBanner('Análise falhou: ' + msg.message, null, 'info');
      break;
    case 'invoked':
      // O usuário clicou no ícone: a aba acabou de receber activeTab.
      if (msg.isMeet) {
        hideBanner();
        if (!ui.running) el.statusText.textContent = 'Aba do Meet liberada. Clique em Iniciar copiloto.';
      } else {
        showBanner('Esta aba não é o Google Meet. Abra a reunião em meet.google.com e clique no ícone da extensão lá.', null, 'info');
      }
      break;
    default:
      break;
  }
}

// ---------- Renderização ----------

function setRunning(running) {
  ui.running = running;
  el.toggleBtn.textContent = running ? 'Parar' : 'Iniciar copiloto';
  el.toggleBtn.classList.toggle('btn-stop', running);
  el.toggleBtn.classList.toggle('btn-primary', !running);
  if (!running) {
    el.statusDot.className = 'brand-dot';
    if (!ui.busy) el.statusText.textContent = 'Pronto para iniciar';
  }
}

function setBusy(busy, text) {
  ui.busy = busy;
  el.toggleBtn.disabled = busy;
  if (busy && text) el.statusText.textContent = text;
}

function renderStatus(status) {
  if (!status) return;
  const labels = {
    idle: 'Pronto para iniciar',
    starting: 'Capturando áudio...',
    connecting: 'Conectando à Gemini...',
    listening: 'Ouvindo a reunião',
    reconnecting: 'Reconectando...',
    error: 'Erro',
  };
  el.statusDot.className = 'brand-dot ' + (status.state || '');
  el.statusText.textContent = status.message || labels[status.state] || status.state;
  el.statusText.title = status.message || '';
}

function renderAnalysis(analysis) {
  const pb = ui.playbook;
  if (!pb) return;
  ui.analysis = analysis;
  const etapaId = analysis?.etapa_atual || pb.etapas[0].id;
  const feitas = new Set(analysis?.perguntas_feitas || []);
  const etapaIdx = Math.max(0, pb.etapas.findIndex((e) => e.id === etapaId));

  // Etapas
  el.stages.innerHTML = '';
  pb.etapas.forEach((etapa, i) => {
    const li = document.createElement('li');
    li.className = i < etapaIdx ? 'done' : i === etapaIdx ? 'active' : '';
    li.innerHTML = `<span class="num">${i + 1}</span><span></span>`;
    li.lastElementChild.textContent = etapa.nome;
    el.stages.appendChild(li);
  });
  el.stageDesc.textContent = pb.etapas[etapaIdx]?.descricao || '';

  // Próxima pergunta
  const next = analysis?.proxima_pergunta || pb.etapas[etapaIdx]?.perguntas.find((p) => !feitas.has(p.id))?.texto || '';
  el.nextQuestion.textContent = next || (ui.running ? 'Todas as perguntas foram feitas.' : 'Inicie o copiloto para receber sugestões.');

  // Checklist
  const total = pb.etapas.reduce((n, e) => n + e.perguntas.length, 0);
  el.checklistCounter.textContent = `${feitas.size}/${total}`;
  el.checklist.innerHTML = '';
  pb.etapas.forEach((etapa, i) => {
    const det = document.createElement('details');
    det.open = i === etapaIdx;
    det.className = i === etapaIdx ? 'active' : '';
    const done = etapa.perguntas.filter((p) => feitas.has(p.id)).length;
    const summary = document.createElement('summary');
    summary.innerHTML = `<span></span><span class="count">${done}/${etapa.perguntas.length}</span>`;
    summary.firstElementChild.textContent = etapa.nome;
    det.appendChild(summary);
    const ul = document.createElement('ul');
    etapa.perguntas.forEach((p) => {
      const li = document.createElement('li');
      const isDone = feitas.has(p.id);
      li.className = isDone ? 'done' : (next && next === p.texto ? 'suggested' : '');
      li.innerHTML = `<span class="box">${isDone ? '✓' : ''}</span><span class="q"></span>`;
      li.lastElementChild.textContent = p.texto;
      ul.appendChild(li);
    });
    det.appendChild(ul);
    el.checklist.appendChild(det);
  });

  // Objeção
  const obj = analysis?.objecao_detectada;
  if (obj && obj.resposta_sugerida && obj.ts !== ui.dismissedObjectionTs) {
    el.objectionType.textContent = obj.tipo || 'Objeção';
    el.objectionAnswer.textContent = obj.resposta_sugerida;
    el.objectionCard.hidden = false;
  } else {
    el.objectionCard.hidden = true;
  }
}

function appendLine(line) {
  el.transcriptEmpty.hidden = true;
  const div = document.createElement('div');
  div.className = `line ${line.speaker}`;
  div.innerHTML = '<span class="who"></span><span class="text"></span>';
  div.firstElementChild.textContent = line.speaker;
  div.lastElementChild.textContent = line.text;
  const partial = ui.partialNodes[line.speaker];
  if (partial) el.transcript.insertBefore(div, partial); else el.transcript.appendChild(div);
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function renderPartial(speaker, text) {
  let node = ui.partialNodes[speaker];
  if (!text) {
    if (node) { node.remove(); ui.partialNodes[speaker] = null; }
    return;
  }
  el.transcriptEmpty.hidden = true;
  if (!node) {
    node = document.createElement('div');
    node.className = `line partial ${speaker}`;
    node.innerHTML = '<span class="who"></span><span class="text"></span>';
    node.firstElementChild.textContent = speaker;
    el.transcript.appendChild(node);
    ui.partialNodes[speaker] = node;
  }
  node.lastElementChild.textContent = text;
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function setLevel(speaker, level) {
  const pct = Math.min(100, Math.round(Math.sqrt(level) * 140));
  (speaker === 'LEAD' ? el.levelLead : el.levelSeller).style.width = pct + '%';
}

function showBanner(text, action, kind = '') {
  el.bannerText.textContent = text;
  el.banner.className = 'banner ' + kind;
  el.banner.hidden = false;
  if (action) {
    el.bannerAction.hidden = false;
    el.bannerAction.textContent = action.label;
    el.bannerAction.onclick = action.onClick;
  } else {
    el.bannerAction.hidden = true;
    el.bannerAction.onclick = null;
  }
}

function hideBanner() {
  el.banner.hidden = true;
}
