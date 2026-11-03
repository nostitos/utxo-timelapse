// Owners popover (landscape/SPEC.md §8): which holders of known addresses to light up, how many
// outputs and how much BTC each holds at the current block, how dim everything else gets
// (owners.dim), and where the addresses come from (owners.json). Outputs are the exact ones
// paying those addresses; the layer itself is replay/owners.js and the terrain's owner plane.

import { fmtInt, fmtBtcTotal, escapeHtml } from './format.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (iso) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
};
const span = (a, b) => (a && b && month(a) !== month(b) ? month(a) + ' to ' + month(b) : month(a || b));

/**
 * Where an entity's addresses come from (owners.json entities[].evidence), as one line: the total,
 * then a clause per evidence type. An address can carry several types, so the clauses can add up
 * to more than the total.
 */
export function evidenceText(entity) {
  const parts = (entity.evidence || []).map((e) => {
    const n = fmtInt(e.addresses || 0);
    const when = span(e.firstObserved, e.lastObserved);
    const hosts = (e.sources || []).map(escapeHtml).join(', ');
    if (e.type === 'service_disclosure') return n + ' from its own published lists' + (when ? ', ' + when : '');
    const about = [hosts, when].filter(Boolean).join(', ');
    if (String(e.type).startsWith('service_disclosure')) return n + ' it announced' + (about ? ' (' + about + ')' : '');
    return n + ' that others attribute to it' + (hosts ? ' (' + hosts + ')' : '');
  });
  if (!parts.length) return [];
  const total = entity.addresses || 0;
  return [escapeHtml(entity.name) + ', ' + fmtInt(total) + (total === 1 ? ' address: ' : ' addresses: ') + parts.join('; ')];
}

/**
 * container: #owners; store: the settings store (owners.dim); onToggle(id, on): show or hide an
 * entity. update({manifest, visible: Set of ids, meta (frame meta.owners), block, loading}) refreshes it.
 */
export function createOwnersMenu({ container, store, onToggle }) {
  container.hidden = true;
  let state = null;
  let html = '';

  function render() {
    if (!state || !state.manifest) return;
    const { manifest, visible, meta, block, loading } = state;
    const active = meta && meta.active;
    const past = Number.isInteger(block) && block > manifest.tip;
    const rows = manifest.entities.map((e, i) => {
      const on = visible.has(e.id);
      const totals = on && active && meta.entities && meta.entities[i];
      const held = totals ? fmtInt(totals.count) + ' outputs \u00b7 ' + fmtBtcTotal(totals.sats) : on && loading ? 'Loading\u2026' : '';
      return '<label class="ow-item' + (on ? ' on' : '') + '"><input type="checkbox" data-owner="' + escapeHtml(e.id) + '"' + (on ? ' checked' : '') + '>' +
        '<i class="ow-swatch" style="background:' + escapeHtml(e.color) + '"></i><span class="ow-name">' + escapeHtml(e.name) + '</span>' +
        '<span class="ow-held">' + held + '</span></label>';
    }).join('');
    const sources = manifest.entities.map((e) => {
      const lines = evidenceText(e);
      return lines.length ? '<li>' + lines.join('; ') + '.</li>' : '';
    }).join('');
    const dim = Number(store.get('owners.dim'));
    const pct = Math.round((Number.isFinite(dim) ? dim : 0.2) * 100);
    const only = !!store.get('owners.only');
    const out =
      '<div class="pl-col"><h3>Owners <span>Outputs paying addresses known to belong to an exchange, lit in its colour at the current block. Only their spends flash.</span></h3>' +
      rows +
      '<label class="ow-only"><input type="checkbox" data-only' + (only ? ' checked' : '') + '><span>Hide the rest</span></label>' +
      '<label class="ow-dim' + (only ? ' off' : '') + '"><span>Dim the rest</span><input type="range" min="0" max="1" step="0.05" value="' + (pct / 100) + '" data-dim aria-label="Brightness of everything else"' + (only ? ' disabled' : '') + '>' +
      '<output>' + pct + '%</output></label>' +
      (past ? '<p class="ow-note">This block is after the owner data, which ends at block ' + fmtInt(manifest.tip) + '; nothing is lit here.</p>' : '') +
      '<ul class="ow-sources">' + sources + '<li>Only the exact outputs paying those addresses, from the block that created each to the block that spent it. Deposit addresses and wallets found only by inference are not included, so this is a lower bound. Owner data runs through block ' + fmtInt(manifest.tip) + '.</li></ul></div>';
    if (out !== html) {
      // Never replace the slider while it is held; the menu redraws when it is let go.
      const slider = container.querySelector('[data-dim]');
      if (slider && document.activeElement === slider) return;
      html = out;
      container.innerHTML = out;
    }
  }

  container.addEventListener('change', (e) => {
    const box = e.target.closest('[data-owner]');
    if (box) onToggle(box.dataset.owner, box.checked);
    if (e.target.matches('[data-only]')) store.set('owners.only', e.target.checked);
    if (e.target.matches('[data-dim]')) {
      e.target.blur();
      render();
    }
  });
  container.addEventListener('input', (e) => {
    if (!e.target.matches('[data-dim]')) return;
    store.set('owners.dim', Number(e.target.value));
    const out = container.querySelector('.ow-dim output');
    if (out) out.textContent = Math.round(Number(e.target.value) * 100) + '%';
  });
  const onDoc = (e) => {
    if (container.hidden) return;
    if (container.contains(e.target) || e.target.closest('[data-act="owners"]')) return;
    api.close();
  };
  document.addEventListener('pointerdown', onDoc);

  const api = {
    get open() {
      return !container.hidden;
    },
    update(next) {
      state = next;
      if (!container.hidden) render();
    },
    toggle() {
      if (container.hidden) {
        html = '';
        render();
      }
      container.hidden = !container.hidden;
    },
    close() {
      container.hidden = true;
    },
  };
  return api;
}
