// Histórico de reuniões salvas em chrome.storage.local.
// Só é acessível em contextos com acesso a chrome.storage (service worker,
// painel, página de histórico). O offscreen document NÃO pode usar isto.

const KEY = 'callHistory';
const MAX_CALLS = 50;
const MAX_LINES_PER_CALL = 3000;

export async function listCalls() {
  const stored = await chrome.storage.local.get(KEY);
  const calls = stored[KEY];
  return Array.isArray(calls) ? calls : [];
}

export async function saveCall(record) {
  if (!record || !Array.isArray(record.transcript) || record.transcript.length === 0) return null;
  const clean = { ...record, transcript: record.transcript.slice(-MAX_LINES_PER_CALL) };
  const calls = await listCalls();
  calls.unshift(clean);
  await chrome.storage.local.set({ [KEY]: calls.slice(0, MAX_CALLS) });
  return clean;
}

export async function getCall(id) {
  return (await listCalls()).find((c) => c.id === id) || null;
}

export async function deleteCall(id) {
  const calls = (await listCalls()).filter((c) => c.id !== id);
  await chrome.storage.local.set({ [KEY]: calls });
  return calls;
}

export async function clearCalls() {
  await chrome.storage.local.set({ [KEY]: [] });
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}min ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

/** Monta um texto pronto para copiar ou baixar. */
export function callToText(call) {
  const lines = [];
  lines.push(`# ${call.titulo || 'Reunião'}`);
  lines.push(`Data: ${new Date(call.startedAt).toLocaleString('pt-BR')}`);
  lines.push(`Duração: ${formatDuration(call.durationMs)}`);
  lines.push(`Playbook: ${call.playbookNome || '-'}`);
  lines.push(`Etapa final: ${call.etapaFinalNome || '-'}`);
  lines.push(`Perguntas feitas: ${call.totalFeitas}/${call.totalPerguntas}`);
  lines.push('');

  const r = call.resumo;
  if (r) {
    lines.push('## Resumo');
    lines.push(r.resumo || '-');
    if (r.perfil_lead) { lines.push(''); lines.push('## Perfil do lead'); lines.push(r.perfil_lead); }
    pushList(lines, 'Dores identificadas', r.dores);
    pushList(lines, 'O que foi bem', r.pontos_fortes);
    pushList(lines, 'O que melhorar', r.pontos_a_melhorar);
    pushList(lines, 'Próximos passos', r.proximos_passos);
  } else if (call.resumoErro) {
    lines.push('## Resumo');
    lines.push('(não foi gerado: ' + call.resumoErro + ')');
  }

  lines.push('', '## Checklist');
  for (const etapa of call.etapas || []) {
    lines.push(`### ${etapa.nome}`);
    for (const p of etapa.perguntas) lines.push(`- [${p.feita ? 'x' : ' '}] ${p.texto}`);
  }

  if (call.objecoes?.length) {
    lines.push('', '## Objeções');
    for (const o of call.objecoes) {
      lines.push(`- ${o.tipo}`);
      if (o.resposta_sugerida) lines.push(`  Resposta sugerida: ${o.resposta_sugerida}`);
    }
  }

  lines.push('', '## Transcrição');
  for (const l of call.transcript) {
    lines.push(`[${new Date(l.ts).toLocaleTimeString('pt-BR')}] ${l.speaker}: ${l.text}`);
  }
  return lines.join('\n');
}

function pushList(lines, titulo, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  lines.push('', `## ${titulo}`);
  for (const i of items) lines.push(`- ${i}`);
}
