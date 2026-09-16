// Service worker (Manifest V3).
// Responsabilidades:
//  - abrir o painel lateral ao clicar no ícone da extensão;
//  - gerar o streamId da aba do Meet (chrome.tabCapture.getMediaStreamId);
//  - criar/fechar o offscreen document que faz a captura de áudio e fala com a Gemini.

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const MEET_HOST = 'meet.google.com';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;

  const handlers = {
    'copilot:start': startCopilot,
    'copilot:stop': stopCopilot,
    'copilot:openOptions': async () => {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
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
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
  return true; // resposta assíncrona
});

async function startCopilot(msg) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('Nenhuma aba ativa encontrada.');

  let host = '';
  try { host = new URL(tab.url || '').hostname; } catch { /* sem URL */ }
  if (host !== MEET_HOST) {
    throw new Error('Abra a aba da reunião do Google Meet (meet.google.com) e deixe-a ativa antes de iniciar.');
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    const text = err?.message || String(err);
    if (/invoked|activeTab/i.test(text)) {
      throw new Error('O Chrome exige que você clique no ícone da extensão com a aba do Meet aberta antes de capturar o áudio. Clique no ícone (isso reabre o painel) e tente de novo.');
    }
    throw new Error('Não foi possível capturar o áudio da aba: ' + text);
  }

  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'offscreen:start',
    streamId,
    tabTitle: tab.title || '',
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
