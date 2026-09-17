// Análise da conversa contra o playbook usando a Gemini API (generateContent com
// resposta JSON estruturada). Recebe a transcrição rotulada por falante e devolve:
// { etapa_atual, perguntas_feitas, proxima_pergunta, objecao_detectada }

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_LINES = 40;

export class PlaybookAnalyzer {
  constructor({ apiKey, model, playbook }) {
    this.apiKey = apiKey;
    this.model = model;
    this.playbook = playbook;
    this.stageIds = playbook.etapas.map((e) => e.id);
    this.questionIds = playbook.etapas.flatMap((e) => e.perguntas.map((p) => p.id));
    this.objectionIds = playbook.objecoes.map((o) => o.id);
    this.systemPrompt = buildSystemPrompt(playbook);
    this.schema = buildSchema(this.stageIds, this.questionIds, this.objectionIds);
  }

  /**
   * @param {{speaker: string, text: string}[]} transcript
   * @param {{etapa_atual: string, perguntas_feitas: string[]}} state
   */
  async analyze(transcript, state) {
    const lines = transcript.slice(-MAX_LINES).map((l) => `[${l.speaker}] ${l.text}`).join('\n');
    const userText =
      `ESTADO ATUAL\n- etapa_atual: ${state.etapa_atual || this.stageIds[0]}\n` +
      `- perguntas_feitas: ${JSON.stringify(state.perguntas_feitas || [])}\n\n` +
      `TRANSCRIÇÃO (mais recente por último)\n${lines || '(vazia)'}\n\n` +
      'Devolva o JSON.';

    const body = {
      systemInstruction: { parts: [{ text: this.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: this.schema,
      },
    };

    // A chave vai no cabeçalho x-goog-api-key, nunca em "?key=". As chaves novas
    // do AI Studio (prefixo "AQ.") só são aceitas no cabeçalho; as antigas
    // (prefixo "AIza") funcionam nos dois formatos.
    const url = `${API_BASE}/${encodeURIComponent(this.model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      if (res.status === 400 && /api key/i.test(detail)) throw new Error('Chave da API inválida. Verifique nas opções.');
      if (res.status === 401) throw new Error('Chave da API não autenticada (401). Confira a chave nas opções. ' + detail);
      if (res.status === 403) throw new Error('Chave da API sem permissão (403). ' + detail);
      if (res.status === 404) throw new Error(`Modelo de análise "${this.model}" não encontrado. Ajuste nas opções.`);
      if (res.status === 429) throw new Error('Limite de requisições da Gemini atingido (429). Tentando de novo em breve.');
      throw new Error(`Erro ${res.status} na análise: ${detail || res.statusText}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('A IA devolveu uma resposta que não é JSON válido.');
    }
    return this.sanitize(parsed, state);
  }

  sanitize(out, state) {
    const etapa = this.stageIds.includes(out.etapa_atual) ? out.etapa_atual : (state.etapa_atual || this.stageIds[0]);
    const feitas = new Set(state.perguntas_feitas || []);
    for (const id of Array.isArray(out.perguntas_feitas) ? out.perguntas_feitas : []) {
      if (this.questionIds.includes(id)) feitas.add(id);
    }
    let objecao = null;
    if (out.objecao_detectada && typeof out.objecao_detectada === 'object' && out.objecao_detectada.tipo) {
      const tipo = String(out.objecao_detectada.tipo);
      const known = this.playbook.objecoes.find((o) => o.id === tipo || o.tipo === tipo);
      objecao = {
        id: known ? known.id : 'outra',
        tipo: known ? known.tipo : tipo,
        resposta_sugerida: String(out.objecao_detectada.resposta_sugerida || known?.resposta || ''),
      };
    }
    return {
      etapa_atual: etapa,
      perguntas_feitas: [...feitas],
      proxima_pergunta: String(out.proxima_pergunta || ''),
      objecao_detectada: objecao,
    };
  }
}

function buildSystemPrompt(pb) {
  const etapas = pb.etapas.map((e, i) => {
    const perguntas = e.perguntas.map((p) => `    - id "${p.id}": ${p.texto}`).join('\n');
    return `${i + 1}. Etapa id "${e.id}" (${e.nome})${e.descricao ? ' - ' + e.descricao : ''}\n${perguntas}`;
  }).join('\n');
  const objecoes = pb.objecoes.map((o) => {
    const gatilhos = Array.isArray(o.gatilhos) && o.gatilhos.length ? ` Sinais: ${o.gatilhos.join('; ')}.` : '';
    return `- id "${o.id}" (${o.tipo}).${gatilhos}\n  Resposta base: ${o.resposta}`;
  }).join('\n');

  return [
    'Você é um copiloto de vendas em tempo real. Você recebe a transcrição de uma reunião de vendas em português do Brasil,',
    'com cada fala rotulada como [VENDEDOR] (quem usa este copiloto) ou [LEAD] (o potencial cliente).',
    'Sua tarefa é comparar a conversa com o playbook abaixo e devolver APENAS um JSON no formato exigido.',
    '',
    pb.instrucoes_gerais ? `CONTEXTO DO PLAYBOOK: ${pb.instrucoes_gerais}\n` : '',
    'ETAPAS E PERGUNTAS OBRIGATÓRIAS:',
    etapas,
    '',
    'OBJEÇÕES CONHECIDAS:',
    objecoes || '(nenhuma)',
    '',
    'REGRAS:',
    '1. "etapa_atual": o id da etapa em que a reunião está agora. Avance quando o conteúdo da conversa mostrar que a etapa mudou; não volte para uma etapa anterior sem evidência clara.',
    '2. "perguntas_feitas": ids das perguntas do playbook que o VENDEDOR já fez, mesmo com outras palavras, desde que o sentido seja o mesmo. Considere as perguntas já marcadas no ESTADO ATUAL e acrescente as novas. Só falas do VENDEDOR contam. Nunca marque uma pergunta que ele não fez.',
    '3. "proxima_pergunta": o texto da melhor próxima pergunta para o VENDEDOR fazer agora, priorizando as perguntas ainda não feitas da etapa atual (adapte o texto ao contexto, ex.: substitua colchetes por informações que o lead já deu). Se todas as perguntas da etapa foram feitas, sugira a primeira da próxima etapa.',
    '4. "objecao_detectada": se o LEAD levantou uma objeção nas ÚLTIMAS falas dele (as 3 mais recentes), devolva o objeto com "tipo" igual ao id da objeção do playbook (ou "outra" se não estiver no playbook) e "resposta_sugerida" com uma quebra de objeção curta (2 a 4 frases), em primeira pessoa, pronta para o vendedor falar, baseada na resposta base do playbook e personalizada com o que o lead disse. Se não houver objeção recente, devolva null.',
    '5. Responda só com o JSON, sem comentários.',
  ].join('\n');
}

function buildSchema(stageIds, questionIds, objectionIds) {
  const questionItem = { type: 'STRING' };
  if (questionIds.length) questionItem.enum = questionIds;
  const tipo = { type: 'STRING' };
  if (objectionIds.length) tipo.enum = [...objectionIds, 'outra'];
  return {
    type: 'OBJECT',
    properties: {
      etapa_atual: { type: 'STRING', enum: stageIds },
      perguntas_feitas: { type: 'ARRAY', items: questionItem },
      proxima_pergunta: { type: 'STRING' },
      objecao_detectada: {
        type: 'OBJECT',
        nullable: true,
        properties: {
          tipo,
          resposta_sugerida: { type: 'STRING' },
        },
        required: ['tipo', 'resposta_sugerida'],
      },
    },
    required: ['etapa_atual', 'perguntas_feitas', 'proxima_pergunta', 'objecao_detectada'],
  };
}
