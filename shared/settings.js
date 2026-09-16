// Configurações compartilhadas (side panel, offscreen e página de opções).

export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';
export const DEFAULT_ANALYSIS_MODEL = 'gemini-3.8-flash';

export const STORAGE_KEYS = {
  apiKey: 'geminiApiKey',
  liveModel: 'liveModel',
  analysisModel: 'analysisModel',
  playbookOverride: 'playbookOverride',
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    apiKey: (stored[STORAGE_KEYS.apiKey] || '').trim(),
    liveModel: (stored[STORAGE_KEYS.liveModel] || '').trim() || DEFAULT_LIVE_MODEL,
    analysisModel: (stored[STORAGE_KEYS.analysisModel] || '').trim() || DEFAULT_ANALYSIS_MODEL,
    playbookOverride: stored[STORAGE_KEYS.playbookOverride] || '',
  };
}

export async function saveSettings(partial) {
  const toStore = {};
  if (partial.apiKey !== undefined) toStore[STORAGE_KEYS.apiKey] = partial.apiKey;
  if (partial.liveModel !== undefined) toStore[STORAGE_KEYS.liveModel] = partial.liveModel;
  if (partial.analysisModel !== undefined) toStore[STORAGE_KEYS.analysisModel] = partial.analysisModel;
  if (partial.playbookOverride !== undefined) toStore[STORAGE_KEYS.playbookOverride] = partial.playbookOverride;
  await chrome.storage.local.set(toStore);
}
