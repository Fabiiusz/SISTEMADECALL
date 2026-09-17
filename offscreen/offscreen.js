// Offscreen document: captura o áudio da aba do Meet (LEAD) e do microfone
// (VENDEDOR), devolve o áudio da aba para os alto-falantes, envia cada fluxo
// para um transcritor da Gemini Live API e roda a análise do playbook.
// Este documento é a "fonte da verdade" do estado do copiloto enquanto ele roda;
// o painel lateral só exibe o que recebe daqui.

// ATENÇÃO: um offscreen document só tem acesso ao chrome.runtime. chrome.storage
// e a leitura de arquivos da extensão NÃO funcionam aqui, por isso as
// configurações e o playbook chegam prontos na mensagem offscreen:start.
import { GeminiLiveTranscriber } from './gemini-live.js';
import { PlaybookAnalyzer } from './analyzer.js';

const SPEAKERS = { tab: 'LEAD', mic: 'VENDEDOR' };
const ANALYSIS_DEBOUNCE_MS = 1200;
const PARTIAL_FLUSH_MS = 2500;
const LEVEL_THROTTLE_MS = 150;

const session = {
  running: false,
  starting: false,
  tabTitle: '',
  playbackCtx: null,
  captureCtx: null,
  streams: [],
  nodes: [],
  transcribers: {},
  analyzer: null,
  playbook: null,
  transcript: [],        // { speaker, text, ts }
  partial: { LEAD: '', VENDEDOR: '' },
  partialTimers: {},
  analysis: null,        // último resultado sanitizado
  analysisTimer: null,
  analysisInFlight: false,
  analysisPending: false,
  status: { state: 'idle', message: '' },
  channelStatus: { LEAD: 'closed', VENDEDOR: 'closed' },
  lastLevelSent: { LEAD: 0, VENDEDOR: 0 },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'offscreen:start':
      start(msg).then(sendResponse).catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: err?.message || String(err), code: err?.code });
      });
      return true;
    case 'offscreen:stop':
      stop().then(() => sendResponse({ ok: true }));
      return true;
    case 'offscreen:getState':
      sendResponse(snapshot());
      return false;
    case 'offscreen:dismissObjection':
      if (session.analysis && session.analysis.objecao_detectada) {
        session.analysis.objecao_detectada = null;
        broadcast({ type: 'analysis', analysis: session.analysis });
      }
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

function snapshot() {
  return {
    ok: true,
    running: session.running,
    tabTitle: session.tabTitle,
    status: session.status,
    channelStatus: session.channelStatus,
    transcript: session.transcript,
    partial: session.partial,
    analysis: session.analysis,
    playbook: session.playbook,
  };
}

function broadcast(payload) {
  chrome.runtime.sendMessage({ target: 'sidepanel', ...payload }).catch(() => {
    // Painel fechado: sem ouvinte. O estado continua aqui e é reenviado ao reabrir.
  });
}

function setStatus(state, message = '') {
  session.status = { state, message };
  broadcast({ type: 'status', status: session.status, running: session.running, channelStatus: session.channelStatus });
}

async function start({ streamId, tabTitle, settings, playbook }) {
  if (session.running || session.starting) return { ok: true, alreadyRunning: true };
  session.starting = true;
  try {
    if (!settings?.apiKey) {
      throw withCode(new Error('Chave da API do Gemini não configurada. Abra as opções e cole a sua chave.'), 'NO_API_KEY');
    }
    if (!playbook?.etapas?.length) {
      throw withCode(new Error('Playbook inválido ou vazio. Verifique o playbook.json.'), 'BAD_PLAYBOOK');
    }
    session.playbook = playbook;
    session.tabTitle = tabTitle || '';
    resetConversation();
    setStatus('starting', 'Capturando áudio...');

    // 1) Áudio da aba (LEAD)
    let tabStream;
    try {
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: false,
      });
    } catch (err) {
      throw withCode(new Error('Falha ao capturar o áudio da aba do Meet: ' + (err?.message || err)), 'TAB_CAPTURE');
    }
    session.streams.push(tabStream);

    // 2) Microfone (VENDEDOR)
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw withCode(new Error('Permissão de microfone negada. Conceda a permissão e inicie de novo.'), 'MIC_DENIED');
      }
      if (name === 'NotFoundError') {
        throw withCode(new Error('Nenhum microfone encontrado.'), 'MIC_NOT_FOUND');
      }
      throw withCode(new Error('Falha ao acessar o microfone: ' + (err?.message || err)), 'MIC_ERROR');
    }
    session.streams.push(micStream);

    // 3) Devolve o áudio da aba para os alto-falantes (a captura silencia a aba).
    session.playbackCtx = new AudioContext();
    session.playbackCtx.createMediaStreamSource(tabStream).connect(session.playbackCtx.destination);
    await session.playbackCtx.resume();

    // 4) Contexto de captura a 16 kHz com um worklet por fluxo.
    session.captureCtx = new AudioContext({ sampleRate: 16000 });
    await session.captureCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
    const silent = session.captureCtx.createGain();
    silent.gain.value = 0;
    silent.connect(session.captureCtx.destination);
    attachCapture(tabStream, SPEAKERS.tab, silent);
    attachCapture(micStream, SPEAKERS.mic, silent);
    await session.captureCtx.resume();

    // 5) Transcritores (um por falante) e analisador.
    session.analyzer = new PlaybookAnalyzer({ apiKey: settings.apiKey, model: settings.analysisModel, playbook });
    for (const speaker of Object.values(SPEAKERS)) {
      session.transcribers[speaker] = new GeminiLiveTranscriber({
        apiKey: settings.apiKey,
        model: settings.liveModel,
        label: speaker,
        onTranscript: (text, finished) => onTranscript(speaker, text, finished),
        onStatus: (st) => onChannelStatus(speaker, st),
        onFatal: (err) => onChannelFatal(speaker, err),
      });
    }
    session.running = true;
    setStatus('connecting', 'Conectando à Gemini...');
    Object.values(session.transcribers).forEach((t) => t.connect());

    // Estado inicial da análise, para o painel já mostrar a primeira etapa.
    session.analysis = {
      etapa_atual: playbook.etapas[0].id,
      perguntas_feitas: [],
      proxima_pergunta: playbook.etapas[0].perguntas[0]?.texto || '',
      objecao_detectada: null,
    };
    broadcast({ type: 'analysis', analysis: session.analysis });
    return snapshot();
  } catch (err) {
    await teardownAudio();
    session.running = false;
    setStatus('error', err?.message || String(err));
    throw err;
  } finally {
    session.starting = false;
  }
}

function attachCapture(stream, speaker, sink) {
  const ctx = session.captureCtx;
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (event) => {
    const { pcm, level } = event.data;
    const transcriber = session.transcribers[speaker];
    if (transcriber) transcriber.sendAudio(pcm);
    const now = Date.now();
    if (now - session.lastLevelSent[speaker] > LEVEL_THROTTLE_MS) {
      session.lastLevelSent[speaker] = now;
      broadcast({ type: 'level', speaker, level });
    }
  };
  source.connect(node);
  node.connect(sink);
  session.nodes.push(source, node);
}

async function stop() {
  session.running = false;
  clearTimeout(session.analysisTimer);
  Object.values(session.partialTimers).forEach(clearTimeout);
  for (const t of Object.values(session.transcribers)) t.close();
  session.transcribers = {};
  await teardownAudio();
  setStatus('idle', 'Copiloto parado.');
}

async function teardownAudio() {
  for (const node of session.nodes) { try { node.disconnect(); } catch { /* ignore */ } }
  session.nodes = [];
  for (const stream of session.streams) stream.getTracks().forEach((t) => t.stop());
  session.streams = [];
  for (const key of ['captureCtx', 'playbackCtx']) {
    const ctx = session[key];
    session[key] = null;
    if (ctx) { try { await ctx.close(); } catch { /* ignore */ } }
  }
}

function resetConversation() {
  session.transcript = [];
  session.partial = { LEAD: '', VENDEDOR: '' };
  session.analysis = null;
  session.analysisPending = false;
  session.channelStatus = { LEAD: 'closed', VENDEDOR: 'closed' };
}

// ---------- Transcrição ----------

function onTranscript(speaker, text, finished) {
  if (text) {
    const current = session.partial[speaker];
    // Normalmente os trechos chegam como incrementos; se vierem acumulados, substitui.
    if (text.length > current.length && text.startsWith(current) && current.length > 0) {
      session.partial[speaker] = text;
    } else {
      session.partial[speaker] = joinText(current, text);
    }
    broadcast({ type: 'partial', speaker, text: session.partial[speaker] });
    clearTimeout(session.partialTimers[speaker]);
    session.partialTimers[speaker] = setTimeout(() => flushPartial(speaker), PARTIAL_FLUSH_MS);
  }
  if (finished) flushPartial(speaker);
}

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  const needsSpace = !/\s$/.test(a) && !/^\s/.test(b) && !/^[,.;:!?]/.test(b);
  return a + (needsSpace ? ' ' : '') + b;
}

function flushPartial(speaker) {
  clearTimeout(session.partialTimers[speaker]);
  const text = session.partial[speaker].trim();
  session.partial[speaker] = '';
  broadcast({ type: 'partial', speaker, text: '' });
  if (!text) return;
  const line = { speaker, text, ts: Date.now() };
  session.transcript.push(line);
  if (session.transcript.length > 400) session.transcript.splice(0, session.transcript.length - 400);
  broadcast({ type: 'transcript', line });
  scheduleAnalysis();
}

function onChannelStatus(speaker, st) {
  session.channelStatus[speaker] = st.state;
  const states = Object.values(session.channelStatus);
  if (states.every((s) => s === 'ready')) {
    setStatus('listening', 'Ouvindo a reunião.');
  } else if (states.some((s) => s === 'reconnecting')) {
    setStatus('reconnecting', st.message || 'Conexão caiu. Reconectando...');
  } else if (session.running) {
    setStatus('connecting', st.message || 'Conectando à Gemini...');
  }
}

function onChannelFatal(speaker, err) {
  console.error(speaker, err);
  stop().then(() => setStatus('error', err.message));
}

// ---------- Análise ----------

function scheduleAnalysis() {
  clearTimeout(session.analysisTimer);
  session.analysisTimer = setTimeout(runAnalysis, ANALYSIS_DEBOUNCE_MS);
}

async function runAnalysis() {
  if (!session.running || !session.analyzer) return;
  if (session.analysisInFlight) { session.analysisPending = true; return; }
  session.analysisInFlight = true;
  broadcast({ type: 'analyzing', value: true });
  try {
    const state = {
      etapa_atual: session.analysis?.etapa_atual,
      perguntas_feitas: session.analysis?.perguntas_feitas || [],
    };
    const result = await session.analyzer.analyze(session.transcript, state);
    if (!session.running) return;
    const previous = session.analysis || {};
    // Mantém a objeção anterior visível até o vendedor dispensar ou surgir outra.
    if (!result.objecao_detectada && previous.objecao_detectada) {
      result.objecao_detectada = previous.objecao_detectada;
    } else if (result.objecao_detectada) {
      const same = previous.objecao_detectada &&
        previous.objecao_detectada.id === result.objecao_detectada.id &&
        previous.objecao_detectada.resposta_sugerida === result.objecao_detectada.resposta_sugerida;
      result.objecao_detectada.ts = same ? previous.objecao_detectada.ts : Date.now();
    }
    session.analysis = result;
    broadcast({ type: 'analysis', analysis: result });
  } catch (err) {
    console.error('analysis', err);
    broadcast({ type: 'analysisError', message: err?.message || String(err) });
  } finally {
    session.analysisInFlight = false;
    broadcast({ type: 'analyzing', value: false });
    if (session.analysisPending) {
      session.analysisPending = false;
      scheduleAnalysis();
    }
  }
}

function withCode(err, code) {
  err.code = code;
  return err;
}
