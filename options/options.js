import { getSettings, saveSettings, DEFAULT_LIVE_MODEL, DEFAULT_ANALYSIS_MODEL } from '../shared/settings.js';
import { validatePlaybook, loadDefaultPlaybook } from '../shared/playbook.js';

const $ = (id) => document.getElementById(id);

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
  setResult('saveResult', 'Salvo.', 'ok');
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
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      setResult('keyResult', `Chave recusada (${res.status}). ${detail}`, 'err');
      return;
    }
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name.replace(/^models\//, ''));
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
