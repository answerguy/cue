const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

contextBridge.exposeInMainWorld('cue', {
  platform,
  initialQuietMode: (() => {
    try {
      return ipcRenderer.sendSync('sync:get-quiet-mode');
    } catch (_) {
      return false;
    }
  })(),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  sherpaModels: () => ipcRenderer.invoke('sherpa:models'),
  sherpaModelDownload: (modelId) => ipcRenderer.invoke('sherpa:model-download', modelId),
  sherpaModelCancel: (modelId) => ipcRenderer.invoke('sherpa:model-cancel', modelId),
  sherpaModelDelete: (modelId) => ipcRenderer.invoke('sherpa:model-delete', modelId),
  sherpaModelImport: (modelId) => ipcRenderer.invoke('sherpa:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[cue] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  windowDragStart: () => ipcRenderer.send('window:drag-start'),
  windowDragEnd: () => ipcRenderer.send('window:drag-end'),
  windowMove: (direction) => ipcRenderer.send('window:move', direction),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  slidesList: () => ipcRenderer.invoke('slides:list'),
  slidesState: () => ipcRenderer.invoke('slides:state'),
  slidesClear: () => ipcRenderer.invoke('slides:clear'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  publikState: () => ipcRenderer.invoke('publik:state'),
  publikAcceptDisclosure: () => ipcRenderer.invoke('publik:accept-disclosure'),
  publikReconnect: () => ipcRenderer.invoke('publik:reconnect'),
  publikRefresh: () => ipcRenderer.invoke('publik:refresh'),
  publikDisconnect: () => ipcRenderer.invoke('publik:disconnect'),
  publikCardSeen: () => ipcRenderer.invoke('publik:card-seen'),
  publikOpen: (url) => ipcRenderer.send('publik:open', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  log: (msg) => ipcRenderer.send('log', msg),
  nofocusGet: () => ipcRenderer.invoke('nofocus:get'),
  nofocusSet: (enabled) => ipcRenderer.invoke('nofocus:set', enabled),
  nofocusToggle: () => ipcRenderer.invoke('nofocus:toggle'),
  stealthGet: () => ipcRenderer.invoke('stealth:get'),
  stealthSet: (enabled) => ipcRenderer.invoke('stealth:set', enabled),
  stealthToggle: () => ipcRenderer.invoke('stealth:toggle'),
  transparencyGet: () => ipcRenderer.invoke('transparency:get'),
  transparencySet: (enabled) => ipcRenderer.invoke('transparency:set', enabled),
  transparencyToggle: () => ipcRenderer.invoke('transparency:toggle'),
  autotypeToggle: (text) => ipcRenderer.invoke('autotype:toggle', text),
  autotypeStatus: () => ipcRenderer.invoke('autotype:status'),
  autotypeSetText: (text) => ipcRenderer.send('autotype:set-text', text),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript', 'transcript:restore', 'stt:interim', 'stt:final', 'stt:status', 'stt:answer-question', 'stt:insert-question', 'history:toggle', 'vad:state', 'applink:consent-request', 'hide:toggle', 'transcription:toggle', 'model:toggle', 'smart:toggle', 'opacity:step', 'whisper:download-progress', 'whisper:models-changed', 'sherpa:download-progress', 'sherpa:models-changed', 'publik:state', 'slides:update', 'nofocus:state', 'transparency:state', 'composer:focus', 'stealth:char', 'stealth:backspace', 'stealth:delete', 'stealth:arrow-left', 'stealth:arrow-right', 'stealth:arrow-up', 'stealth:arrow-down', 'stealth:page-up', 'stealth:page-down', 'stealth:home', 'stealth:end', 'stealth:submit', 'stealth:cancel', 'stealth:paste', 'stealth:select-all', 'stealth:state', 'response:retry', 'prompt:previous', 'response:previous', 'response:next', 'hr:trigger', 'resume:trigger', 'autotype:state', 'quiet:toggle', 'quiet:resize', 'alt-x:toggle'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
