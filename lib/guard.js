// Origin blocklist + agent tab ownership. Mirrors the CLI check (defence in depth).
const GROUP_KEY = 'agentGroupId';

export function isBlockedUrl(url, blockedOrigins) {
  if (!url || url === 'about:blank') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return true; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return (blockedOrigins || []).some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export async function agentGroupId() {
  const stored = await chrome.storage.session.get(GROUP_KEY);
  const id = stored[GROUP_KEY];
  if (typeof id !== 'number') return null;
  try { await chrome.tabGroups.get(id); return id; } catch { return null; }
}

export async function addToAgentGroup(tabId) {
  const existing = await agentGroupId();
  const groupId = await chrome.tabs.group(existing === null ? { tabIds: [tabId] } : { tabIds: [tabId], groupId: existing });
  if (existing === null) {
    await chrome.tabGroups.update(groupId, { title: 'AppAI', color: 'purple', collapsed: false });
    await chrome.storage.session.set({ [GROUP_KEY]: groupId });
  }
  return groupId;
}

/** The agent may only touch tabs inside its own group, never the user's other tabs. */
export async function requireAgentTab(tabId) {
  if (typeof tabId !== 'number') throw new Error('tab_id is required');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`Tab ${tabId} does not exist`);
  const groupId = await agentGroupId();
  if (groupId === null || tab.groupId !== groupId) throw new Error(`Tab ${tabId} is not an agent tab; open pages with browser_open`);
  return tab;
}
