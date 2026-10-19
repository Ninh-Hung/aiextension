// chrome.debugger wrapper + per-tab console/network buffers.
const attached = new Map(); // tabId -> { console: [], network: Map, inflight: number, refs: Map, lastNetworkAt }
const MAX_NETWORK = 500;

export function stateFor(tabId) { return attached.get(tabId); }

export async function ensureAttached(tabId, consoleBufferSize = 500) {
  const existing = attached.get(tabId);
  if (existing) { existing.consoleMax = consoleBufferSize; return existing; }
  // After a service-worker restart the tab may still be attached from the previous run.
  await chrome.debugger.attach({ tabId }, '1.3').catch((err) => { if (!/already attached/i.test(String(err?.message))) throw err; });
  const state = { console: [], network: new Map(), inflight: 0, refs: new Map(), lastNetworkAt: Date.now(), consoleMax: consoleBufferSize };
  attached.set(tabId, state);
  for (const domain of ['Runtime', 'Log', 'Network', 'Page', 'DOM', 'Accessibility']) await send(tabId, `${domain}.enable`);
  return state;
}

export function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

function pushConsole(state, entry) {
  state.console.push({ ts: new Date().toISOString(), ...entry });
  if (state.console.length > state.consoleMax) state.console.splice(0, state.console.length - state.consoleMax);
}

const argText = (arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type);

export function handleEvent(source, method, params) {
  const state = attached.get(source.tabId);
  if (!state) return;
  if (method === 'Runtime.consoleAPICalled') {
    const frame = params.stackTrace?.callFrames?.[0];
    pushConsole(state, { level: params.type === 'warning' ? 'warn' : params.type, text: params.args.map(argText).join(' '), url: frame?.url, line: frame?.lineNumber, column: frame?.columnNumber });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails;
    pushConsole(state, { level: 'error', text: d.exception?.description || d.text, url: d.url, line: d.lineNumber, column: d.columnNumber, stack: (d.stackTrace?.callFrames || []).map((f) => ({ url: f.url, line: f.lineNumber, column: f.columnNumber, fn: f.functionName })) });
  } else if (method === 'Log.entryAdded') {
    pushConsole(state, { level: params.entry.level === 'warning' ? 'warn' : params.entry.level, text: params.entry.text, url: params.entry.url, line: params.entry.lineNumber });
  } else if (method === 'Network.requestWillBeSent') {
    state.inflight += 1; state.lastNetworkAt = Date.now();
    state.network.set(params.requestId, { id: params.requestId, method: params.request.method, url: params.request.url, type: params.type, startedAt: params.timestamp });
    if (state.network.size > MAX_NETWORK) state.network.delete(state.network.keys().next().value);
  } else if (method === 'Network.responseReceived') {
    const entry = state.network.get(params.requestId);
    if (entry) Object.assign(entry, { status: params.response.status, mime: params.response.mimeType });
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    state.inflight = Math.max(0, state.inflight - 1); state.lastNetworkAt = Date.now();
    const entry = state.network.get(params.requestId);
    if (entry) { entry.durationMs = Math.round((params.timestamp - entry.startedAt) * 1000); if (method === 'Network.loadingFailed') entry.failed = params.errorText; }
  }
}

export function handleDetach(source) { attached.delete(source.tabId); }
