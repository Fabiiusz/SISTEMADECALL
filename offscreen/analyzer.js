// Análise da conversa contra o playbook usando a Gemini API (generateContent com
// resposta JSON estruturada). Recebe a transcrição rotulada por falante e devolve:
// { etapa_atual, perguntas_feitas, proxima_pergunta, objecao_detectada }

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Janela curta de falas: o ESTADO ATUAL já carrega tudo que foi reconhecido
// antes, e uma marcação nunca é removida, então não há motivo para reenviar a
// conversa inteira a cada chamada. Menos texto significa resposta mais rápida.
const MAX_LINES = 12;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 900;
// Sem limite de tempo, uma chamada travada segura o painel por um minuto e meio.
const TIMEOUT_MS = 25000;
// 503 é congestionamento passageiro: insistir no modelo preferido costuma dar
// certo. Só trocamos depois de várias recusas seguidas, e voltamos depois.
const OVERLOADS_BEFORE_SWITCH = 3;
const RETURN_TO_PREFERRED_MS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "gemini-3.8-flash" -> 3.8, para ordenar do mais novo para o mais antigo. */
function versionOf(name) {
  const m = /gemini-(\d+)(?:\.(\d+))?/.exec(name);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0) : 0;
}

function transient(err) {
  err.transient = true;
  return err;
}

export class PlaybookAnalyzer {
  constructor({ apiKey, model, playbook }) {
    this.apiKey = apiKey;
    this.model = model;
    this.playbook = playbook;
    this.stageIds = playbook.etapas.map((e) => e.id);
    this.questionIds = playbook.etapas.flatMap((e) => e.perguntas.map((p) => p.id));
    this.objectionIds = playbook.objecoes.map((o) => o.id);
    this.preferredModel = model;
    this.bad = new Set();
    this.switching = null;
    this.consecutiveOverloads = 0;
    this.switchedAt = 0;
    this.lastDurationMs = 0;
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
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: this.schema,
      },
    };

    // 503 e 429 são passageiros: o modelo está congestionado do lado do Google.
    // Repetimos com espera crescente e, se insistir, trocamos para outro modelo
    // rápido da própria conta em vez de desistir.
    // Se trocamos de modelo por congestionamento, volta ao preferido depois de
    // um tempo: o modelo preferido costuma ser o mais capaz.
    if (this.model !== this.preferredModel &&
        !this.bad.has(this.preferredModel) &&
        Date.now() - this.switchedAt > RETURN_TO_PREFERRED_MS) {
      this.model = this.preferredModel;
      this.consecutiveOverloads = 0;
    }

    const startedAt = Date.now();
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const parsed = await this.callModel(body);
        this.consecutiveOverloads = 0;
        this.lastDurationMs = Date.now() - startedAt;
        return this.sanitize(parsed, state);
      } catch (err) {
        lastError = err;
        this.lastDurationMs = Date.now() - startedAt;
        if (!err.transient) throw err;

        if (err.badModel) {
          // Modelo inexistente: não adianta insistir, troca na hora.
          this.bad.add(this.model);
          if (!(await this.switchModel())) throw err;
          continue;
        }
        if (err.overloaded) {
          this.consecutiveOverloads += 1;
          if (this.consecutiveOverloads >= OVERLOADS_BEFORE_SWITCH && await this.switchModel()) {
            continue;
          }
        }
        if (attempt < MAX_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async callModel(body) {
    // A chave vai no cabeçalho x-goog-api-key, nunca em "?key=".
    const url = `${API_BASE}/${encodeURIComponent(this.model)}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw transient(new Error(`O modelo "${this.model}" demorou mais de ${TIMEOUT_MS / 1000}s para responder.`));
      }
      throw transient(new Error('Falha de rede ao falar com a Gemini: ' + (err?.message || err)));
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      if (res.status === 400 && /api key/i.test(detail)) throw new Error('Chave da API inválida. Verifique nas opções.');
      if (res.status === 401) throw new Error('Chave da API não autenticada (401). Confira a chave nas opções. ' + detail);
      if (res.status === 403) throw new Error('Chave da API sem permissão (403). ' + detail);
      if (res.status === 404) {
        const err = transient(new Error(`Modelo de análise "${this.model}" não existe nesta conta.`));
        err.badModel = true;
        throw err;
      }
      if (res.status === 429) throw transient(new Error('Limite de requisições atingido (429).'));
      if (res.status === 503 || res.status === 500) {
        const err = transient(new Error(`Modelo "${this.model}" congestionado (${res.status}).`));
        err.overloaded = true;
        throw err;
      }
      throw new Error(`Erro ${res.status} na análise: ${detail || res.statusText}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('A IA devolveu uma resposta que não é JSON válido.');
    }
  }

  /**
   * Troca para outro modelo rápido que a conta realmente tenha.
   * Só considera o que a API lista, nunca um nome inventado.
   * @returns {Promise<boolean>} true se trocou de modelo
   */
  async switchModel() {
    if (this.switching) return this.switching;
    this.switching = (async () => {
      try {
        if (!this.available) {
          const res = await fetch(`${MODELS_URL}?pageSize=200`, { headers: { 'x-goog-api-key': this.apiKey } });
          if (!res.ok) return false;
          const data = await res.json();
          this.available = (data.models || [])
            .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map((m) => m.name.replace(/^models\//, ''))
            .filter((n) => /flash/i.test(n) && !/(live|audio|image|tts|embedding|vision|thinking)/i.test(n))
            // Mais novo primeiro, para cair num modelo atual e não num obsoleto.
            .sort((a, b) => versionOf(b) - versionOf(a));
        }
        const next = this.available.find((n) => !this.bad.has(n) && n !== this.model);
        if (!next) return false;
        this.model = next;
        this.switchedAt = Date.now();
        this.consecutiveOverloads = 0;
        return true;
      } catch {
        return false;
      } finally {
        this.switching = null;
      }
    })();
    return this.switching;
  }

  /**
   * Resumo e análise da reunião inteira, para o histórico. Best-effort: se
   * falhar, o histórico é salvo sem resumo.
   * @param {{speaker: string, text: string}[]} transcript
   */
  async summarize(transcript) {
    const conversa = transcript.map((l) => `[${l.speaker}] ${l.text}`).join('\n');
    const body = {
      systemInstruction: { parts: [{ text:
        'Você analisa reuniões de vendas em português do Brasil. Recebe a transcrição, com falas do VENDEDOR e do LEAD, ' +
        'e devolve APENAS um JSON. Seja específico e use os fatos ditos na conversa, nunca generalidades. ' +
        'Nas críticas, seja direto e útil, como um gestor de vendas experiente faria numa devolutiva.' }] },
      contents: [{ role: 'user', parts: [{ text: `TRANSCRIÇÃO DA REUNIÃO\n${conversa}\n\nDevolva o JSON.` }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            resumo: { type: 'STRING' },
            perfil_lead: { type: 'STRING' },
            dores: { type: 'ARRAY', items: { type: 'STRING' } },
            pontos_fortes: { type: 'ARRAY', items: { type: 'STRING' } },
            pontos_a_melhorar: { type: 'ARRAY', items: { type: 'STRING' } },
            proximos_passos: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['resumo', 'perfil_lead', 'dores', 'pontos_fortes', 'pontos_a_melhorar', 'proximos_passos'],
        },
      },
    };
    return this.callModel(body);
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
    'REGRA 1 - etapa_atual',
    'O id da etapa em que a reunião está agora. Avance quando o conteúdo mostrar que a etapa mudou.',
    'Não volte para uma etapa anterior sem evidência clara.',
    '',
    'REGRA 2 - perguntas_feitas (a mais importante)',
    'Compare por SENTIDO, nunca por palavras. O vendedor quase nunca repete o texto do playbook, e não precisa repetir.',
    'Marque a pergunta como feita sempre que o VENDEDOR tocou no assunto dela, mesmo que ele:',
    '  - use palavras completamente diferentes;',
    '  - troque números, prazos ou detalhes (o playbook diz "30 minutos" e ele fala "40 minutos": conta do mesmo jeito);',
    '  - pergunte de forma indireta, ou como afirmação, em vez de pergunta;',
    '  - divida o assunto em duas ou três falas seguidas;',
    '  - use gírias, abreviações ou linguagem informal.',
    'Exemplos de equivalência, para você calibrar:',
    '  - "Você tem os 30 minutos combinados?" equivale a "temos uns 40 minutos?", "seu tempo tá tranquilo?", "consegue ficar até as 15h?".',
    '  - "Qual é o maior problema que você enfrenta?" equivale a "o que mais te incomoda hoje?", "onde é que aperta?", "qual a maior dor de vocês?".',
    '  - "Quem mais participa da decisão?" equivale a "você decide sozinho?", "mais alguém precisa aprovar?", "tem sócio nisso?".',
    'Na dúvida entre marcar e não marcar, MARQUE, desde que o assunto tenha sido realmente coberto.',
    'Fazer o vendedor repetir uma pergunta que ele já fez atrapalha mais do que deixar passar.',
    'Só falas do [VENDEDOR] contam: o lead falar sobre um assunto não marca a pergunta.',
    'Considere as perguntas já marcadas no ESTADO ATUAL e some as novas. Uma vez marcada, a pergunta continua marcada.',
    'A transcrição abaixo traz só as falas mais recentes: o que foi reconhecido antes já está no ESTADO ATUAL.',
    'Repita no JSON os ids que já vieram no ESTADO ATUAL e acrescente os novos.',
    '',
    'REGRA 3 - proxima_pergunta',
    'O texto da melhor próxima pergunta para o VENDEDOR fazer agora, priorizando as ainda não feitas da etapa atual.',
    'Adapte o texto ao contexto: troque os colchetes por informações que o lead já deu, e use as palavras dele.',
    'Se todas as perguntas da etapa foram feitas, sugira a primeira da próxima etapa.',
    '',
    'REGRA 4 - objecao_detectada',
    'Objeção é QUALQUER sinal de resistência, dúvida, hesitação ou adiamento vindo do [LEAD]. Inclui, entre outros:',
    '  - preço, orçamento, "está caro", "não temos verba", comparação com concorrente mais barato;',
    '  - adiamento, "vou pensar", "me manda por e-mail", "depois eu vejo", "não é o momento";',
    '  - falta de autonomia, "preciso falar com meu sócio", "não decido sozinho", "vou levar para o time";',
    '  - desconfiança, "será que funciona?", "já tentamos algo assim e não deu certo";',
    '  - tempo e prioridade, "estamos sem gente", "temos outras prioridades agora".',
    'Olhe as 3 falas mais recentes do [LEAD]. Se houver qualquer um desses sinais, devolva o objeto.',
    'Em "tipo", use o id da objeção do playbook que mais se aproximar, mesmo que o lead use outras palavras.',
    'Use "outra" apenas quando não houver nenhuma parecida no playbook.',
    'Em "resposta_sugerida", escreva de 2 a 4 frases, em primeira pessoa, prontas para o vendedor falar em voz alta agora.',
    'Parta da resposta base do playbook e personalize com as palavras e os dados que o próprio lead deu na conversa.',
    'Não escreva instruções nem comentários: escreva a fala pronta.',
    'Se as falas recentes do lead não tiverem nenhum sinal de resistência, devolva null.',
    '',
    'Responda só com o JSON, sem comentários e sem texto fora dele.',
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
