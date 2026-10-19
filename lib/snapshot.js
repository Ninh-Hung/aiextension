// Accessibility-tree snapshot with ref ids that browser_act can target.
import { send, stateFor } from './cdp.js';

const SKIP_ROLES = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak', 'LabelText']);

export async function snapshot(tabId, { max_nodes: maxNodes = 400, scope_ref: scopeRef } = {}) {
  const state = stateFor(tabId);
  const { nodes } = await send(tabId, 'Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const scopeBackend = scopeRef ? state.refs.get(scopeRef) : null;
  if (scopeRef && !scopeBackend) throw new Error(`Unknown scope_ref ${scopeRef}; take a new browser_snapshot`);
  state.refs = new Map();
  const lines = [];
  let count = 0;
  let counter = 0;

  const visit = (node, depth, parentName = '') => {
    if (count >= maxNodes) return;
    const role = node.role?.value;
    const name = (node.name?.value || '').toString().replace(/\s+/g, ' ').trim();
    // Text that only repeats its parent's accessible name (button "Greet" > "Greet") is noise.
    const repeatsParent = role === 'StaticText' && parentName.includes(name);
    const show = !node.ignored && role && !SKIP_ROLES.has(role) && (name || role !== 'StaticText') && !repeatsParent;
    let nextDepth = depth;
    if (show) {
      let ref = '';
      if (node.backendDOMNodeId) { counter += 1; ref = ` [ref=e${counter}]`; state.refs.set(`e${counter}`, node.backendDOMNodeId); }
      const props = (node.properties || []).filter((p) => ['checked', 'disabled', 'expanded', 'selected', 'required'].includes(p.name) && p.value?.value !== false).map((p) => p.name + (p.value?.value === true ? '' : `=${p.value?.value}`));
      const value = node.value?.value ? ` value="${String(node.value.value).slice(0, 80)}"` : '';
      lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` "${name.slice(0, 120)}"` : ''}${value}${props.length ? ` (${props.join(', ')})` : ''}${ref}`);
      count += 1;
      nextDepth = depth + 1;
    }
    for (const childId of node.childIds || []) { const child = byId.get(childId); if (child) visit(child, nextDepth, name); }
  };

  const root = scopeBackend ? nodes.find((n) => n.backendDOMNodeId === scopeBackend) : nodes[0];
  if (root) visit(root, 0);
  if (count >= maxNodes) lines.push(`... truncated at ${maxNodes} nodes; pass scope_ref or a larger max_nodes`);
  return lines.join('\n');
}
