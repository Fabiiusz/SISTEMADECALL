// Service worker (Manifest V3).
// Responsabilidades:
//  - abrir o painel lateral e conceder a permissão activeTab à aba do Meet;
//  - gerar o streamId da aba (chrome.tabCapture.getMediaStreamId);
//  - criar/fechar o offscreen document que faz a captura e fala com a Gemini.

import { getSettings } from './shared/settings.js';
import { loadPlaybook } from './shared/playbook.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const MEET_HOST = 'meet.google.com';
const INVOKED_TAB_KEY = 'invokedTabId';

// IMPORTANTE: openPanelOnActionClick PRECISA ser false.
// Com ele em true o Chrome abre o painel sozinho e não dispara action.onClicked.
// Sem esse evento a extensão nunca recebe a permissão activeTab, e o
// chrome.tabCapture recusa a captura com "extension has not been invoked".
// O valor fica gravado no perfil do usuário e sobrevive a recarregamentos da
// extensão, por isso reaplicamos em toda inicialização do service worker.
async function resetPanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (err) {
    console.error('setPanelBehavior', err);
  }
}
resetPanelBehavior();
chrome.runtime.onInstalled.addListener(resetPanelBehavior);
chrome.runtime.onStartup.addListener(resetPanelBehavior);

// O clique no ícone é o "gesto qualificado" que concede activeTab para a aba.
// A concessão vale até a aba navegar, então o botão "Iniciar copiloto" do painel
// consegue usá-la logo em seguida. Cliques dentro do painel NÃO concedem nada.
//
// ATENÇÃO: chrome.sidePanel.open() só funciona enquanto o gesto do usuário
// continua válido. Qualquer await antes dele, inclusive um storage.session.set,
// encerra o gesto e o Chrome recusa a abertura com "may only be called in
// response to a user gesture". Por isso o listener NÃO é async e o open() é a
// primeira instrução; o resto do trabalho vai para uma função assíncrona.
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id }).catch((err) => console.error('sidePanel.open', err));
  }
  void rememberInvokedTab(tab);
});

async function rememberInvokedTab(tab) {
  if (tab?.id !== undefined) {
    try {
      await chrome.storage.session.set({ [INVOKED_TAB_KEY]: tab.id });
    } catch (err) {
      console.warn('storage.session', err);
    }
  }
  chrome.runtime.sendMessage({
    target: 'sidepanel',
    type: 'invoked',
    isMeet: hostOf(tab?.url) === MEET_HOST,
  }).catch(() => { /* painel ainda abrindo; ele consulta o contexto ao carregar */ });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;

  const handlers = {
    'copilot:start': startCopilot,
    'copilot:stop': stopCopilot,
    'copilot:openOptions': async () => {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    },
    'copilot:getContext': async () => {
      const tab = await resolveMeetTab();
      return { ok: true, isMeet: !!tab, tabTitle: tab?.title || '' };
    },
    'copilot:openPermissionPage': async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
      return { ok: true };
    },
  };

  const handler = handlers[msg.type];
  if (!handler) return false;

  handler(msg)
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.error(msg.type, err);
      sendResponse({ ok: false, error: err?.message || String(err), code: err?.code });
    });
  return true; // resposta assíncrona
});

function hostOf(url) {
  try { return new URL(url || '').hostname; } catch { return ''; }
}

/** Prefere a aba em que o usuário clicou no ícone, porque é ela que tem activeTab. */
async function resolveMeetTab() {
  try {
    const stored = await chrome.storage.session.get(INVOKED_TAB_KEY);
    const invokedId = stored[INVOKED_TAB_KEY];
    if (invokedId !== undefined) {
      const tab = await chrome.tabs.get(invokedId).catch(() => null);
      if (tab && hostOf(tab.url) === MEET_HOST) return tab;
    }
  } catch (e) {
    console.warn('resolveMeetTab', e);
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && hostOf(active.url) === MEET_HOST) return active;
  return null;
}

async function startCopilot() {
  const tab = await resolveMeetTab();
  if (!tab) {
    throw withCode(
      new Error('Abra a aba da reunião em meet.google.com e clique no ícone da extensão nessa aba antes de iniciar.'),
      'NO_MEET_TAB',
    );
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    const text = err?.message || String(err);
    if (/invoked|activeTab/i.test(text)) {
      throw withCode(
        new Error('O Chrome ainda não liberou a captura desta aba. Clique no ícone da extensão na barra de ferramentas, com a aba do Meet à frente, e depois clique em Iniciar copiloto de novo.'),
        'NEEDS_INVOKE',
      );
    }
    throw new Error('Não foi possível capturar o áudio da aba: ' + text);
  }

  // Um offscreen document só enxerga chrome.runtime: nada de chrome.storage nem
  // de leitura de arquivos da extensão. Por isso o service worker lê as
  // configurações e o playbook aqui e entrega tudo pronto na mensagem.
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw withCode(
      new Error('Chave da API do Gemini não configurada. Abra as opções e cole a sua chave.'),
      'NO_API_KEY',
    );
  }
  const { playbook } = await loadPlaybook();

  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'offscreen:start',
    streamId,
    tabTitle: tab.title || '',
    settings,
    playbook,
  });
  if (!response) throw new Error('O documento de captura não respondeu.');
  if (!response.ok) {
    // Falhou ao iniciar (ex.: microfone negado): libera o offscreen document.
    await closeOffscreenDocument();
  }
  return response;
}

async function stopCopilot() {
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen:stop' });
    } catch (e) {
      console.warn('offscreen:stop', e);
    }
    await closeOffscreenDocument();
  }
  return { ok: true };
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }
  return chrome.offscreen.hasDocument();
}

let creatingOffscreen = null;
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Captura o áudio da aba do Meet e do microfone para transcrição em tempo real.',
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn('closeDocument', e);
  }
}

function withCode(err, code) {
  err.code = code;
  return err;
}
