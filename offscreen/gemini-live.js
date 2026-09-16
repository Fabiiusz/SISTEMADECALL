// Cliente da Gemini Live API (WebSocket) usado como transcritor de um fluxo de áudio.
// Cada instância cuida de UM falante (LEAD ou VENDEDOR) e entrega os trechos
// transcritos via callback. Trata reconexão com retomada de sessão.

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MAX_RETRIES = 6;

export class GeminiLiveTranscriber {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model  ex.: gemini-3.8-live
   * @param {string} opts.label  'LEAD' | 'VENDEDOR'
   * @param {(text: string, finished: boolean) => void} opts.onTranscript
   * @param {(status: {state: string, message?: string}) => void} opts.onStatus
   * @param {(error: Error) => void} opts.onFatal
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.label = opts.label;
    this.onTranscript = opts.onTranscript;
    this.onStatus = opts.onStatus || (() => {});
    this.onFatal = opts.onFatal || (() => {});

    this.ws = null;
    this.ready = false;
    this.closedByUser = false;
    this.resumeHandle = null;
    this.retries = 0;
    this.everConnected = false;
    this.reconnectTimer = null;
  }

  get state() {
    return this.ready ? 'ready' : this.ws ? 'connecting' : 'closed';
  }

  connect() {
    if (this.closedByUser) return;
    clearTimeout(this.reconnectTimer);
    this.ready = false;
    this.onStatus({ state: 'connecting', message: this.retries ? `Reconectando (${this.retries}/${MAX_RETRIES})...` : 'Conectando...' });

    const url = `${WS_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify(this.buildSetup()));
    };

    ws.onmessage = async (event) => {
      let text = event.data;
      if (text instanceof Blob) text = await text.text();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      this.handleServerMessage(msg);
    };

    ws.onerror = () => {
      // O evento de erro não traz detalhes; o onclose que vem em seguida traz o código.
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasReady = this.ready;
      this.ready = false;
      if (this.closedByUser) {
        this.onStatus({ state: 'closed' });
        return;
      }

      const reason = (event.reason || '').trim();
      if (!this.everConnected && looksLikeAuthError(event.code, reason)) {
        this.onFatal(new Error(`Chave da API rejeitada pela Gemini Live API (${reason || 'código ' + event.code}). Verifique a chave nas opções.`));
        return;
      }
      if (!this.everConnected && reason && /model|not found|unsupported|invalid/i.test(reason)) {
        this.onFatal(new Error(`A Gemini recusou a configuração: ${reason}. Confira o nome do modelo Live nas opções.`));
        return;
      }

      if (this.retries >= MAX_RETRIES) {
        this.onFatal(new Error(`Conexão com a Gemini caiu (${reason || 'código ' + event.code}) e não foi possível reconectar.`));
        return;
      }
      const delay = wasReady && this.goAwayPending ? 200 : Math.min(16000, 1000 * 2 ** this.retries);
      this.goAwayPending = false;
      this.retries += 1;
      this.onStatus({ state: 'reconnecting', message: `Conexão caiu (${reason || 'código ' + event.code}). Reconectando em ${Math.round(delay / 1000)}s...` });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  buildSetup() {
    const setup = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ['TEXT'],
        temperature: 0,
      },
      systemInstruction: {
        parts: [{
          text: 'Você é um transcritor silencioso. Nunca converse, nunca comente, nunca responda ao conteúdo. ' +
                'Sempre que precisar responder, responda apenas com o caractere "." e nada mais.',
        }],
      },
      inputAudioTranscription: { languageCodes: ['pt-BR'] },
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: 700 },
        activityHandling: 'NO_INTERRUPTION',
      },
      contextWindowCompression: {
        triggerTokens: 25600,
        slidingWindow: { targetTokens: 12800 },
      },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    };
    return { setup };
  }

  handleServerMessage(msg) {
    if (msg.setupComplete) {
      this.ready = true;
      this.everConnected = true;
      this.retries = 0;
      this.onStatus({ state: 'ready' });
      return;
    }
    if (msg.sessionResumptionUpdate) {
      const upd = msg.sessionResumptionUpdate;
      if (upd.resumable && upd.newHandle) this.resumeHandle = upd.newHandle;
      return;
    }
    if (msg.goAway) {
      // O servidor vai encerrar a conexão em breve; reconectamos assim que fechar.
      this.goAwayPending = true;
      this.onStatus({ state: 'ready', message: 'Servidor pediu troca de conexão; retomando a sessão...' });
      return;
    }
    const content = msg.serverContent;
    if (!content) return;

    const finalT = content.inputTranscription;
    if (finalT && typeof finalT.text === 'string' && finalT.text.length) {
      this.onTranscript(finalT.text, finalT.finished === true);
    } else if (finalT && finalT.finished === true) {
      this.onTranscript('', true);
    }
    // A resposta do modelo (modelTurn) é ignorada de propósito: só queremos a transcrição.
    if (content.turnComplete) {
      this.onTranscript('', true);
    }
  }

  /** @param {ArrayBuffer} pcm16 mono 16 kHz little-endian */
  sendAudio(pcm16) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      realtimeInput: {
        audio: { data: arrayBufferToBase64(pcm16), mimeType: 'audio/pcm;rate=16000' },
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      } catch { /* ignore */ }
      ws.close(1000, 'stop');
    }
  }
}

function looksLikeAuthError(code, reason) {
  if (/api key|api_key|unauthenticated|permission denied|forbidden|401|403/i.test(reason)) return true;
  return code === 1008 && !reason;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
