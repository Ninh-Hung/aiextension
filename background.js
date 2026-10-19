// Service worker: native messaging link to `appai` (via the com.appaihelp.browser host) + command execution.
import { dispatch } from './lib/commands.js';
import { handleDetach, handleEvent } from './lib/cdp.js';

const HOST = 'com.appaihelp.browser';
let port = null;

function connect() {
  if (port) return;
  try { port = chrome.runtime.connectNative(HOST); } catch { port = null; return; }
  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg.id !== 'string') return; // e.g. host_error
    try {
      const res = await dispatch(msg);
      port?.postMessage({ id: msg.id, ok: true, ...res });
    } catch (err) {
      port?.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) });
    }
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; });
}

chrome.debugger.onEvent.addListener(handleEvent);
chrome.debugger.onDetach.addListener(handleDetach);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// Reconnect when `appai` was started after the browser (the host exits immediately when no session runs).
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'reconnect') connect(); });
connect();
