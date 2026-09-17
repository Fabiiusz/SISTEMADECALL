import { getSettings, saveSettings, DEFAULT_LIVE_MODEL, DEFAULT_ANALYSIS_MODEL } from '../shared/settings.js';
import { validatePlaybook, loadDefaultPlaybook } from '../shared/playbook.js';

const $ = (id) => document.getElementById(id);

// Nomes de modelo que a conta realmente tem, usados para sugerir e para avisar
// quando alguém digita um modelo inexistente (o que quebra a análise em uso).
let knownModels = [];

init();

async function init() {
  const s = await getSettings();
  $('apiKey').value = s.apiKey;
  $('liveModel').value = s.liveModel === DEFAULT_LIVE_MODEL ? '' : s.liveModel;
  $('analysisModel').value = s.analysisModel === DEFAULT_ANALYSIS_MODEL ? '' : s.analysisModel;
  $('playbookOverride').value = s.playbookOverride;

  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? 'Ocultar' : 'Mostrar';
  });
  $('testKey').addEventListener('click', testKey);
  $('validatePlaybook').addEventListener('click', () => validateEditor(true));
  $('loadDefaultPlaybook').addEventListener('click', async () => {
    const pb = await loadDefaultPlaybook();
    $('playbookOverride').value = JSON.stringify(pb, null, 2);
    setResult('playbookResult', 'playbook.json carregado no editor. Edite e clique em Salvar.', 'ok');
  });
  $('clearPlaybook').addEventListener('click', () => {
    $('playbookOverride').value = '';
    setResult('playbookResult', 'O arquivo playbook.json da extensão será usado após salvar.', 'ok');
  });
  $('save').addEventListener('click', save);
  if (s.apiKey) loadModelList(s.apiKey).then(checkConfiguredModels).catch(() => {});
}

async function loadModelList(key) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': key },
  });
  if (!res.ok) return [];
  const data = await res.json();
  knownModels = (data.models || []).map((m) => m.name.replace(/^models\//, ''));
  fillDatalist('liveModels', knownModels.filter((n) => /live|audio|transcribe/i.test(n)));
  fillDatalist('analysisModels', knownModels.filter((n) => /flash|pro/i.test(n) && !/(live|audio|image|tts|embedding)/i.test(n)));
  return knownModels;
}

function fillDatalist(id, names) {
  const list = $(id);
  list.innerHTML = '';
  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n;
    list.appendChild(opt);
  }
}

function unknownModels() {
  if (knownModels.length === 0) return [];
  return [$('liveModel').value.trim(), $('analysisModel').value.trim()]
    .filter((m) => m && !knownModels.includes(m));
}

function checkConfiguredModels() {
  const bad = unknownModels();
  setResult('modelResult', bad.length
    ? `Atenção: ${bad.join(' e ')} não existe(m) na sua conta. Escolha um nome da lista ou deixe o campo em branco.`
    : '', bad.length ? 'err' : '');
}

async function save() {
  const override = $('playbookOverride').value.trim();
  if (override && !validateEditor(false)) {
    setResult('saveResult', 'Corrija o playbook antes de salvar.', 'err');
    return;
  }
  await saveSettings({
    apiKey: $('apiKey').value.trim(),
    liveModel: $('liveModel').value.trim(),
    analysisModel: $('analysisModel').value.trim(),
    playbookOverride: override,
  });
  checkConfiguredModels();
  const bad = unknownModels();
  setResult('saveResult', bad.length ? `Salvo, mas ${bad.join(' e ')} não existe(m) na sua conta.` : 'Salvo.', bad.length ? 'err' : 'ok');
  if (bad.length) return;
  setTimeout(() => setResult('saveResult', ''), 2500);
}

function validateEditor(showOk) {
  const raw = $('playbookOverride').value.trim();
  if (!raw) { setResult('playbookResult', 'Editor vazio: o arquivo padrão será usado.', 'ok'); return true; }
  let pb;
  try { pb = JSON.parse(raw); } catch (e) { setResult('playbookResult', 'JSON inválido: ' + e.message, 'err'); return false; }
  const errors = validatePlaybook(pb);
  if (errors.length) { setResult('playbookResult', errors.join(' '), 'err'); return false; }
  if (showOk) {
    const q = pb.etapas.reduce((n, e) => n + e.perguntas.length, 0);
    setResult('playbookResult', `Playbook válido: ${pb.etapas.length} etapas, ${q} perguntas, ${pb.objecoes.length} objeções.`, 'ok');
  }
  return true;
}

async function testKey() {
  const key = $('apiKey').value.trim();
  if (!key) { setResult('keyResult', 'Cole a chave primeiro.', 'err'); return; }
  setResult('keyResult', 'Testando...');
  try {
    // A chave vai no cabeçalho, para aceitar tanto o formato novo ("AQ.") quanto o antigo ("AIza").
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      const hint = (res.status === 401 || res.status === 403)
        ? ' Confira se copiou a chave inteira, sem espaços, e se ela não foi revogada.'
        : '';
      setResult('keyResult', `Chave recusada (${res.status}). ${detail}${hint}`, 'err');
      return;
    }
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name.replace(/^models\//, ''));
    await loadModelList(key).catch(() => {});
    const live = names.filter((n) => /live|audio/i.test(n));
    const liveModel = $('liveModel').value.trim() || DEFAULT_LIVE_MODEL;
    const analysisModel = $('analysisModel').value.trim() || DEFAULT_ANALYSIS_MODEL;
    const missing = [liveModel, analysisModel].filter((m) => names.length && !names.includes(m));
    let text = `Chave válida. ${names.length} modelos disponíveis.`;
    if (live.length) text += ` Modelos Live/áudio: ${live.join(', ')}.`;
    if (missing.length) text += ` Atenção: ${missing.join(' e ')} não aparece(m) na lista; ajuste os modelos acima.`;
    setResult('keyResult', text, missing.length ? 'err' : 'ok');
  } catch (e) {
    setResult('keyResult', 'Falha de rede ao testar: ' + e.message, 'err');
  }
}

function setResult(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.className = 'result ' + kind;
}
