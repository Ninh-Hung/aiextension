// Command dispatcher: every command is checked against the origin blocklist before and after it ran.
import { addToAgentGroup, isBlockedUrl, requireAgentTab, agentGroupId } from './guard.js';
import { ensureAttached, send, stateFor, detach, setBlockedOrigins, quarantineTab } from './cdp.js';
import { snapshot } from './snapshot.js';
import { runActions } from './actions.js';

const MAX_IMAGE_B64 = 900_000; // native messaging host→Chrome… and Chrome→host frames stay well under 1 MB
const originMatches = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };
/** Current or pending (not yet committed) URL is blocked. */
async function tabIsBlocked(tabId, blocked) {
  const tab = await chrome.tabs.get(tabId);
  return isBlockedUrl(tab.url, blocked) || (!!tab.pendingUrl && isBlockedUrl(tab.pendingUrl, blocked));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitLoaded(tabId, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await sleep(150);
  }
  return chrome.tabs.get(tabId);
}

async function screenshot(tabId, params) {
  let quality = 80;
  let scale = 1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data } = await send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality, ...(params.region ? { clip: { ...params.region, scale } } : {}) });
    if (data.length <= MAX_IMAGE_B64) return { image_base64: data, image_mime: 'image/jpeg' };
    quality -= 20; scale *= 0.7;
  }
  throw new Error('Screenshot is too large to send; use browser_viewport to shrink the page');
}

async function evaluate(tabId, expression) {
  const res = await send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 10000 });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result.value !== undefined ? res.result.value : res.result.description;
}

async function waitFor(tabId, { condition, value, timeout_ms: timeoutMs = 10000 }) {
  if (condition === 'ms') { await sleep(Math.min(Number(value) || 0, 30000)); return 'waited'; }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition === 'selector' && (await evaluate(tabId, `!!document.querySelector(${JSON.stringify(value)})`))) return 'selector found';
    if (condition === 'text' && (await evaluate(tabId, `document.body && document.body.innerText.includes(${JSON.stringify(value)})`))) return 'text found';
    if (condition === 'network_idle') { const s = stateFor(tabId); if (s.inflight === 0 && Date.now() - s.lastNetworkAt > 500) return 'network idle'; }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${condition}`);
}

function readConsole(state, p, blocked) {
  let list = state.console.filter((e) => !e.url || !isBlockedUrl(e.url, blocked));
  if (Array.isArray(p.levels) && p.levels.length) list = list.filter((e) => p.levels.includes(e.level));
  if (p.pattern) { let re; try { re = new RegExp(p.pattern, 'i'); } catch { throw new Error('Invalid pattern'); } list = list.filter((e) => re.test(e.text || '')); }
  if (p.since) list = list.filter((e) => e.ts >= p.since);
  const out = list.slice(-(p.limit || 100));
  if (p.clear) state.console = [];
  return out;
}

async function readNetwork(tabId, state, p, blocked, tabUrl) {
  let list = [...state.network.values()].filter((e) => !isBlockedUrl(e.url, blocked));
  if (p.url_pattern) { let re; try { re = new RegExp(p.url_pattern, 'i'); } catch { throw new Error('Invalid url_pattern'); } list = list.filter((e) => re.test(e.url)); }
  if (typeof p.status_min === 'number') list = list.filter((e) => (e.status || 0) >= p.status_min || e.failed);
  const out = list.slice(-(p.limit || 50)).map((e) => ({ ...e }));
  if (p.include_body) {
    // Bodies only for requests to the tab's own origin: a third-party response must not ride along.
    const tabOrigin = new URL(tabUrl).origin;
    for (const entry of out.filter((e) => originMatches(e.url, tabOrigin)).slice(-5)) {
      const body = await send(tabId, 'Network.getResponseBody', { requestId: entry.id }).catch(() => null);
      if (body) entry.body = (body.base64Encoded ? '[binary]' : body.body).slice(0, 4000);
    }
  }
  return out;
}

export async function dispatch({ cmd, tab_id: tabId, params = {}, blocked_origins: blocked = [] }, opts = {}) {
  const consoleSize = opts.consoleBufferSize || 500;
  setBlockedOrigins(blocked);
  if (cmd === 'open') {
    if (isBlockedUrl(params.url, blocked)) throw new Error('URL is blocked');
    let tab;
    if (params.new_tab === false && (await agentGroupId()) !== null) {
      const groupTabs = await chrome.tabs.query({ groupId: await agentGroupId() });
      if (groupTabs[0]) tab = await chrome.tabs.update(groupTabs[0].id, { url: params.url });
    }
    if (!tab) { tab = await chrome.tabs.create({ url: params.url, active: false }); await addToAgentGroup(tab.id); }
    const loaded = await waitLoaded(tab.id);
    if (isBlockedUrl(loaded.url, blocked)) { await quarantineTab(tab.id); throw new Error('Page redirected to a blocked origin'); }
    await ensureAttached(tab.id, consoleSize);
    return { data: { tab_id: tab.id, title: loaded.title }, tab_url: loaded.url };
  }
  if (cmd === 'tabs') {
    const groupId = await agentGroupId();
    const tabs = groupId === null ? [] : await chrome.tabs.query({ groupId });
    if (params.action === 'list') return { data: { tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })) } };
    const tab = await requireAgentTab(tabId);
    if (params.action === 'switch') { await chrome.tabs.update(tab.id, { active: true }); return { data: { tab_id: tab.id }, tab_url: (await chrome.tabs.get(tab.id)).url }; }
    if (params.action === 'close') { await detach(tab.id); await chrome.tabs.remove(tab.id); return { data: { closed: tab.id } }; }
    throw new Error('Unknown tabs action');
  }
  const tab = await requireAgentTab(tabId);
  if (cmd === 'tab_info') return { tab_url: tab.url, data: { title: tab.title } };
  if (cmd === 'leave') { await send(tabId, 'Page.navigate', { url: 'about:blank' }).catch(() => chrome.tabs.update(tabId, { url: 'about:blank' })); return { tab_url: 'about:blank' }; }
  if (isBlockedUrl(tab.url, blocked)) throw new Error('Tab is on a blocked origin');
  const state = await ensureAttached(tabId, consoleSize);
  const startGen = state.blockedGen;
  let result;
  switch (cmd) {
    case 'snapshot': result = { data: await snapshot(tabId, params) }; break;
    case 'screenshot': result = await screenshot(tabId, params); break;
    case 'act': result = { data: await runActions(tabId, params.actions, opts.maxBatch || 10, async () => state.blockedGen !== startGen || (await tabIsBlocked(tabId, blocked))) }; await sleep(300); break;
    case 'console': result = { data: readConsole(state, params, blocked) }; break;
    case 'network': result = { data: await readNetwork(tabId, state, params, blocked, tab.url) }; break;
    case 'eval': result = { data: await evaluate(tabId, String(params.expression ?? '')) }; break;
    case 'wait': result = { data: await waitFor(tabId, params) }; break;
    case 'reload': await send(tabId, 'Page.reload', { ignoreCache: params.hard === true }); await sleep(200); await waitLoaded(tabId); result = { data: 'reloaded' }; break;
    case 'viewport': await send(tabId, 'Emulation.setDeviceMetricsOverride', { width: params.width, height: params.height, deviceScaleFactor: params.device_scale || 1, mobile: params.width < 600 }); result = { data: 'viewport set' }; break;
    default: throw new Error(`Unknown command ${cmd}`);
  }
  const finalUrl = (await chrome.tabs.get(tabId)).url;
  if (state.blockedGen !== startGen || (await tabIsBlocked(tabId, blocked))) { await quarantineTab(tabId); throw new Error('Tab visited a blocked origin during the command; content discarded'); }
  return { ...result, tab_url: finalUrl };
}
