// Cliente da Gemini Live API (WebSocket) usado como transcritor de um fluxo de áudio.
// Cada instância cuida de UM falante (LEAD ou VENDEDOR).
//
// O servidor responde "Internal error encountered" quando algum campo do setup
// não serve para o modelo escolhido, sem dizer qual. Como não dá para testar
// cada combinação de antemão, a classe tenta uma escada de configurações, da
// mais desejável para a mais simples, até uma conectar. A que funcionar fica
// travada para as reconexões seguintes e aparece no diagnóstico.

const WS_HOST = 'wss://generativelanguage.googleapis.com';
const FALLBACK_MODEL = 'gemini-3.5-transcribe-live';
const MAX_RETRIES = 6;
const VARIANT_RETRY_MS = 400;

export class GeminiLiveTranscriber {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.label = opts.label;
    this.onTranscript = opts.onTranscript;
    this.onStatus = opts.onStatus || (() => {});
    this.onFatal = opts.onFatal || (() => {});

    this.variants = buildVariants(this.model);
    this.variantIndex = 0;
    this.variantLocked = false;
    this.failures = [];

    this.ws = null;
    this.ready = false;
    this.closedByUser = false;
    this.resumeHandle = null;
    this.retries = 0;
    this.everConnected = false;
    this.goAwayPending = false;
    this.reconnectTimer = null;
  }

  get variant() {
    return this.variants[Math.min(this.variantIndex, this.variants.length - 1)];
  }

  get variantLabel() {
    return this.variant.label;
  }

  connect() {
    if (this.closedByUser) return;
    clearTimeout(this.reconnectTimer);
    this.ready = false;

    const variant = this.variant;
    this.onStatus({
      state: 'connecting',
      variant: variant.label,
      message: this.variantLocked
        ? (this.retries ? `Reconectando (${this.retries}/${MAX_RETRIES})...` : 'Conectando...')
        : `Testando configuração "${variant.label}"...`,
    });

    const url = `${WS_HOST}/ws/google.ai.generativelanguage.${variant.apiVersion}` +
      `.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify(this.buildSetup()));

    ws.onmessage = async (event) => {
      let text = event.data;
      if (text instanceof Blob) text = await text.text();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      this.handleServerMessage(msg);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      if (this.closedByUser) { this.onStatus({ state: 'closed' }); return; }

      const reason = (event.reason || '').trim() || `código ${event.code}`;

      // Ainda não conseguimos conectar nenhuma vez: é a configuração que está
      // sendo recusada, então passamos para a próxima da escada.
      if (!this.variantLocked) {
        this.failures.push(`${variant.label}: ${reason}`);
        if (looksLikeAuthError(event.code, reason)) {
          this.onFatal(new Error(`A Gemini recusou a chave da API (${reason}). Verifique a chave nas opções.`));
          return;
        }
        if (this.variantIndex < this.variants.length - 1) {
          this.variantIndex += 1;
          this.onStatus({ state: 'connecting', message: `Configuração "${variant.label}" recusada (${reason}). Tentando outra...` });
          this.reconnectTimer = setTimeout(() => this.connect(), VARIANT_RETRY_MS);
          return;
        }
        this.onFatal(new Error(
          'Nenhuma configuração da Live API foi aceita. Tentativas: ' + this.failures.join(' | '),
        ));
        return;
      }

      // Já funcionou antes: queda de rede comum, reconecta com espera crescente.
      if (this.retries >= MAX_RETRIES) {
        this.onFatal(new Error(`Conexão com a Gemini caiu (${reason}) e não foi possível reconectar.`));
        return;
      }
      const delay = this.goAwayPending ? 200 : Math.min(16000, 1000 * 2 ** this.retries);
      this.goAwayPending = false;
      this.retries += 1;
      this.onStatus({ state: 'reconnecting', message: `Conexão caiu (${reason}). Reconectando em ${Math.round(delay / 1000)}s...` });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  buildSetup() {
    const v = this.variant;
    const setup = { model: `models/${v.model}` };
    if (v.generationConfig) setup.generationConfig = v.generationConfig;
    if (v.inputAudioTranscription) setup.inputAudioTranscription = v.inputAudioTranscription;
    if (this.variantLocked && this.resumeHandle) setup.sessionResumption = { handle: this.resumeHandle };
    return { setup };
  }

  handleServerMessage(msg) {
    if (msg.setupComplete) {
      this.ready = true;
      this.everConnected = true;
      this.variantLocked = true; // esta configuração serve; não mexer mais
      this.retries = 0;
      this.onStatus({ state: 'ready', variant: this.variantLabel });
      return;
    }
    if (msg.sessionResumptionUpdate) {
      const upd = msg.sessionResumptionUpdate;
      if (upd.resumable && upd.newHandle) this.resumeHandle = upd.newHandle;
      return;
    }
    if (msg.goAway) {
      this.goAwayPending = true;
      return;
    }
    const content = msg.serverContent;
    if (!content) return;

    const t = content.inputTranscription;
    if (t && typeof t.text === 'string' && t.text.length) {
      this.onTranscript(t.text, t.finished === true);
    } else if (t && t.finished === true) {
      this.onTranscript('', true);
    }
    // A resposta do modelo é ignorada de propósito: só queremos a transcrição.
    if (content.turnComplete) this.onTranscript('', true);
  }

  /** @param {ArrayBuffer} pcm16 mono 16 kHz little-endian */
  sendAudio(pcm16) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: { audio: { data: arrayBufferToBase64(pcm16), mimeType: 'audio/pcm;rate=16000' } },
    }));
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

/** Da configuração mais desejável para a mais simples. */
function buildVariants(model) {
  const list = [
    { label: 'texto', apiVersion: 'v1beta', model, generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: {} },
    { label: 'áudio', apiVersion: 'v1beta', model, generationConfig: { responseModalities: ['AUDIO'] }, inputAudioTranscription: {} },
    { label: 'sem generationConfig', apiVersion: 'v1beta', model, generationConfig: null, inputAudioTranscription: {} },
    { label: 'v1alpha', apiVersion: 'v1alpha', model, generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: {} },
  ];
  if (model !== FALLBACK_MODEL) {
    list.push({
      label: `modelo ${FALLBACK_MODEL}`,
      apiVersion: 'v1beta',
      model: FALLBACK_MODEL,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: {},
    });
  }
  return list;
}

function looksLikeAuthError(code, reason) {
  return /api key|api_key|unauthenticated|permission denied|forbidden|\b401\b|\b403\b/i.test(reason);
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
