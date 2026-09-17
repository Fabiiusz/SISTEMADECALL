import { listCalls, deleteCall, clearCalls, formatDuration, callToText } from '../shared/history.js';

const $ = (id) => document.getElementById(id);
let calls = [];
let selectedId = null;

init();

async function init() {
  $('clearAll').addEventListener('click', async () => {
    if (!calls.length) return;
    if (!confirm(`Apagar as ${calls.length} reuniões salvas? Isso não pode ser desfeito.`)) return;
    await clearCalls();
    await refresh();
  });
  await refresh();
}

async function refresh() {
  calls = await listCalls();
  $('count').textContent = calls.length
    ? `${calls.length} reunião(ões) salva(s). As mais antigas são descartadas depois de 50.`
    : '';
  $('empty').hidden = calls.length > 0;
  renderList();
  if (calls.length && !calls.some((c) => c.id === selectedId)) selectedId = calls[0].id;
  renderDetail();
}

function renderList() {
  const ul = $('list');
  ul.innerHTML = '';
  for (const call of calls) {
    const li = document.createElement('li');
    li.className = call.id === selectedId ? 'active' : '';
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = new Date(call.startedAt).toLocaleString('pt-BR');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${formatDuration(call.durationMs)} · ${call.totalFeitas}/${call.totalPerguntas} perguntas · ${call.transcript.length} falas`;
    li.append(when, meta);
    li.addEventListener('click', () => { selectedId = call.id; renderList(); renderDetail(); });
    ul.appendChild(li);
  }
}

function renderDetail() {
  const box = $('detail');
  const call = calls.find((c) => c.id === selectedId);
  box.hidden = !call;
  if (!call) return;
  box.innerHTML = '';

  box.appendChild(h('h2', call.titulo || 'Reunião'));
  const stats = el('div', 'stats');
  stats.innerHTML =
    `<span>Data: <b>${new Date(call.startedAt).toLocaleString('pt-BR')}</b></span>` +
    `<span>Duração: <b>${formatDuration(call.durationMs)}</b></span>` +
    `<span>Perguntas: <b>${call.totalFeitas}/${call.totalPerguntas}</b></span>` +
    `<span>Etapa final: <b>${escapeHtml(call.etapaFinalNome || '-')}</b></span>`;
  box.appendChild(stats);

  const actions = el('div', 'actions');
  actions.appendChild(button('Copiar tudo', async (btn) => {
    await navigator.clipboard.writeText(callToText(call));
    btn.textContent = 'Copiado!';
    setTimeout(() => { btn.textContent = 'Copiar tudo'; }, 1500);
  }));
  actions.appendChild(button('Baixar .md', () => download(call)));
  actions.appendChild(button('Apagar esta', async () => {
    if (!confirm('Apagar esta reunião?')) return;
    await deleteCall(call.id);
    selectedId = null;
    await refresh();
  }));
  box.appendChild(actions);

  const r = call.resumo;
  if (r) {
    box.appendChild(h('h3', 'Resumo'));
    box.appendChild(h('p', r.resumo || '-'));
    if (r.perfil_lead) { box.appendChild(h('h3', 'Perfil do lead')); box.appendChild(h('p', r.perfil_lead)); }
    addList(box, 'Dores identificadas', r.dores);
    addList(box, 'O que foi bem', r.pontos_fortes);
    addList(box, 'O que melhorar', r.pontos_a_melhorar);
    addList(box, 'Próximos passos', r.proximos_passos);
  } else {
    box.appendChild(h('h3', 'Resumo'));
    box.appendChild(h('p', 'Não foi gerado. ' + (call.resumoErro || '')));
  }

  box.appendChild(h('h3', 'Checklist'));
  for (const etapa of call.etapas || []) {
    const block = el('div', 'stage-block');
    block.appendChild(h('h4', etapa.nome));
    const ul = el('ul', 'check');
    for (const p of etapa.perguntas) {
      const li = document.createElement('li');
      li.className = p.feita ? 'done' : '';
      const box2 = el('span', 'box');
      box2.textContent = p.feita ? '✓' : '';
      const txt = document.createElement('span');
      txt.textContent = p.texto;
      li.append(box2, txt);
      ul.appendChild(li);
    }
    block.appendChild(ul);
    box.appendChild(block);
  }

  if (call.objecoes?.length) {
    box.appendChild(h('h3', 'Objeções'));
    for (const o of call.objecoes) {
      const d = el('div', 'obj');
      d.appendChild(h('b', o.tipo || 'Objeção'));
      d.appendChild(h('span', o.resposta_sugerida || ''));
      box.appendChild(d);
    }
  }

  box.appendChild(h('h3', 'Transcrição'));
  const lines = el('div', 'lines');
  for (const l of call.transcript) {
    const div = el('div', `line ${l.speaker}`);
    const t = el('span', 't');
    t.textContent = new Date(l.ts).toLocaleTimeString('pt-BR');
    const who = el('span', 'who');
    who.textContent = l.speaker;
    const text = document.createElement('span');
    text.textContent = l.text;
    div.append(t, who, text);
    lines.appendChild(div);
  }
  box.appendChild(lines);
}

function addList(parent, titulo, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  parent.appendChild(h('h3', titulo));
  const ul = document.createElement('ul');
  for (const i of items) {
    const li = document.createElement('li');
    li.textContent = i;
    ul.appendChild(li);
  }
  parent.appendChild(ul);
}

function download(call) {
  const blob = new Blob([callToText(call)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date(call.startedAt);
  a.href = url;
  a.download = `reuniao-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function h(tag, text) { const n = document.createElement(tag); n.textContent = text; return n; }
function el(tag, cls) { const n = document.createElement(tag); n.className = cls; return n; }
function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', () => onClick(b));
  return b;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
