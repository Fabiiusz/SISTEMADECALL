// Carregamento e validação do playbook.
// Por padrão lê o arquivo playbook.json da extensão; se houver um playbook
// personalizado salvo na página de opções, ele tem prioridade.

import { getSettings } from './settings.js';

export function validatePlaybook(pb) {
  const errors = [];
  if (!pb || typeof pb !== 'object') return ['O playbook precisa ser um objeto JSON.'];
  if (!Array.isArray(pb.etapas) || pb.etapas.length === 0) errors.push('"etapas" precisa ser uma lista com pelo menos uma etapa.');
  if (!Array.isArray(pb.objecoes)) errors.push('"objecoes" precisa ser uma lista (pode ser vazia).');

  const stageIds = new Set();
  const questionIds = new Set();
  (pb.etapas || []).forEach((etapa, i) => {
    if (!etapa.id) errors.push(`Etapa ${i + 1} sem "id".`);
    if (!etapa.nome) errors.push(`Etapa ${i + 1} sem "nome".`);
    if (stageIds.has(etapa.id)) errors.push(`Id de etapa duplicado: "${etapa.id}".`);
    stageIds.add(etapa.id);
    if (!Array.isArray(etapa.perguntas)) errors.push(`Etapa "${etapa.id}" precisa ter a lista "perguntas".`);
    (etapa.perguntas || []).forEach((p, j) => {
      if (!p.id) errors.push(`Pergunta ${j + 1} da etapa "${etapa.id}" sem "id".`);
      if (!p.texto) errors.push(`Pergunta "${p.id}" sem "texto".`);
      if (questionIds.has(p.id)) errors.push(`Id de pergunta duplicado: "${p.id}".`);
      questionIds.add(p.id);
    });
  });

  const objIds = new Set();
  (pb.objecoes || []).forEach((o, i) => {
    if (!o.id) errors.push(`Objeção ${i + 1} sem "id".`);
    if (!o.tipo) errors.push(`Objeção "${o.id}" sem "tipo".`);
    if (!o.resposta) errors.push(`Objeção "${o.id}" sem "resposta".`);
    if (objIds.has(o.id)) errors.push(`Id de objeção duplicado: "${o.id}".`);
    objIds.add(o.id);
  });
  return errors;
}

export async function loadDefaultPlaybook() {
  const res = await fetch(chrome.runtime.getURL('playbook.json'));
  if (!res.ok) throw new Error('Não foi possível ler playbook.json');
  return res.json();
}

/** Retorna { playbook, origem: 'arquivo' | 'personalizado' } */
export async function loadPlaybook() {
  const { playbookOverride } = await getSettings();
  if (playbookOverride) {
    try {
      const pb = JSON.parse(playbookOverride);
      const errors = validatePlaybook(pb);
      if (errors.length === 0) return { playbook: pb, origem: 'personalizado' };
      console.warn('Playbook personalizado inválido, usando o arquivo padrão:', errors);
    } catch (e) {
      console.warn('Playbook personalizado não é JSON válido, usando o arquivo padrão.', e);
    }
  }
  const pb = await loadDefaultPlaybook();
  const errors = validatePlaybook(pb);
  if (errors.length) throw new Error('playbook.json inválido: ' + errors.join(' '));
  return { playbook: pb, origem: 'arquivo' };
}

export function allQuestionIds(pb) {
  return pb.etapas.flatMap((e) => e.perguntas.map((p) => p.id));
}

export function findQuestion(pb, id) {
  for (const etapa of pb.etapas) {
    const q = etapa.perguntas.find((p) => p.id === id);
    if (q) return { etapa, pergunta: q };
  }
  return null;
}
