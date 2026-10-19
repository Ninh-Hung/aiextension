// chrome.debugger wrapper + per-tab console/network buffers.
import { isBlockedUrl } from './guard.js';

// Latest admin blocklist seen in a command; lets event handlers react to navigations between commands.
let blockedOrigins = [];
export function setBlockedOrigins(list) { blockedOrigins = Array.isArray(list) ? list : []; }
const attached = new Map(); // tabId -> { console: [], network: Map, inflight: number, refs: Map, lastNetworkAt }
const MAX_NETWORK = 500;

export function stateFor(tabId) { return attached.get(tabId); }

export async function ensureAttached(tabId, consoleBufferSize = 500) {
  const existing = attached.get(tabId);
  if (existing) { existing.consoleMax = consoleBufferSize; return existing; }
  // After a service-worker restart the tab may still be attached from the previous run.
  await chrome.debugger.attach({ tabId }, '1.3').catch((err) => { if (!/already attached/i.test(String(err?.message))) throw err; });
  const state = { console: [], network: new Map(), inflight: 0, refs: new Map(), blockedGen: 0, lastNetworkAt: Date.now(), consoleMax: consoleBufferSize };
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

const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };

/** Blocked page: drop everything captured so far and leave. */
export async function quarantineTab(tabId) {
  const state = attached.get(tabId);
  if (state) { state.console = []; state.network.clear(); state.refs = new Map(); }
  await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: 'about:blank' }).catch(() => chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {}));
}

function onMainFrameNavigated(tabId, state, url) {
  state.refs = new Map(); // refs of the previous document are meaningless
  // Counted before quarantining, so a command that overlapped a blocked hop can discard its result
  // even though the tab is back on about:blank by the time the command finishes.
  if (isBlockedUrl(url, blockedOrigins)) { state.blockedGen += 1; void quarantineTab(tabId); return; }
  // Buffers captured on another origin must not leak into this page's results.
  const origin = originOf(url);
  if (state.origin && origin !== state.origin) { state.console = []; state.network.clear(); }
  state.origin = origin;
}

export function handleEvent(source, method, params) {
  const state = attached.get(source.tabId);
  if (!state) return;
  if (method === 'Page.frameNavigated' && !params.frame.parentId) { onMainFrameNavigated(source.tabId, state, params.frame.url); return; }
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
