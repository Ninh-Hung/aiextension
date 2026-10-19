// UI actions through CDP Input.* / DOM.*; a batch stops at the first failure.
import { send, stateFor } from './cdp.js';

const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

async function center(tabId, ref) {
  const backendNodeId = stateFor(tabId).refs.get(ref);
  if (!backendNodeId) throw new Error(`Unknown ref ${ref}; take a new browser_snapshot`);
  await send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
  const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId });
  const q = model.content;
  return { backendNodeId, x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function point(tabId, action) {
  if (action.ref) return center(tabId, action.ref);
  if (typeof action.x === 'number' && typeof action.y === 'number') return { x: action.x, y: action.y };
  throw new Error('Action needs ref or x/y');
}

async function click(tabId, action, clickCount = 1) {
  const { x, y } = await point(tabId, action);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
}

async function callOnNode(tabId, backendNodeId, fn, args = []) {
  const { object } = await send(tabId, 'DOM.resolveNode', { backendNodeId });
  return send(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true });
}

const HANDLERS = {
  click: (tabId, a) => click(tabId, a),
  double_click: (tabId, a) => click(tabId, a, 2),
  hover: async (tabId, a) => { const { x, y } = await point(tabId, a); await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
  type: async (tabId, a) => {
    if (typeof a.text !== 'string') throw new Error('type needs text');
    if (a.ref) {
      const { backendNodeId } = await center(tabId, a.ref);
      await send(tabId, 'DOM.focus', { backendNodeId });
      if (a.clear) await callOnNode(tabId, backendNodeId, 'function(){ if (this.select) this.select(); }');
    }
    await send(tabId, 'Input.insertText', { text: a.text });
  },
  key: async (tabId, a) => {
    const key = String(a.key || '');
    if (!key) throw new Error('key needs key');
    const code = KEYS[key];
    const base = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: key === 'Enter' ? '\r' : key.length === 1 ? key : undefined };
    await send(tabId, 'Input.dispatchKeyEvent', { type: base.text ? 'keyDown' : 'rawKeyDown', ...base });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  },
  scroll: async (tabId, a) => {
    const { x, y } = a.ref || typeof a.x === 'number' ? await point(tabId, a) : { x: 200, y: 200 };
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: a.dx || 0, deltaY: a.dy ?? 400 });
  },
  select: async (tabId, a) => {
    const { backendNodeId } = await center(tabId, a.ref);
    await callOnNode(tabId, backendNodeId, 'function(v){ this.value = v; this.dispatchEvent(new Event("input",{bubbles:true})); this.dispatchEvent(new Event("change",{bubbles:true})); }', [String(a.value ?? '')]);
  },
  upload: async () => { throw new Error('upload is not supported yet (it would expose local files to the page)'); },
};

export async function runActions(tabId, actions, maxBatch, isBlockedNow = async () => false) {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('actions must be a non-empty array');
  if (actions.length > maxBatch) throw new Error(`Too many actions (${actions.length} > ${maxBatch})`);
  const done = [];
  for (const [index, action] of actions.entries()) {
    const handler = HANDLERS[action?.type];
    if (!handler) return { completed: done.length, failed: { index, error: `Unknown action type ${action?.type}` }, done };
    try { if (await isBlockedNow()) throw new Error('Tab is on a blocked origin'); await handler(tabId, action); done.push(action.type); } catch (err) { return { completed: done.length, failed: { index, type: action.type, error: err.message }, done }; }
  }
  return { completed: done.length, done };
}
