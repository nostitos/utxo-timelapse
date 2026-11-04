// Owners popover (landscape/SPEC.md §8): which holders of known addresses to light up, how many
// outputs and how much BTC each holds at the current block, whether everything else is hidden
// (owners.only) or flat (owners.flat) and how dim it gets (owners.dim), and where the addresses
// come from (owners.json). Outputs are the exact ones
// paying those addresses; the layer itself is replay/owners.js and the terrain's owner plane.
// The many small owners share one row, Other exchanges, lit together in one colour (ownerGroup).

import { fmtInt, fmtBtcTotal, escapeHtml } from './format.js';

/** The row that lights the small owners together. Its grey is far from every owner colour (spec test). */
export const OTHER_OWNERS = Object.freeze({ id: 'other-exchanges', name: 'Other exchanges', color: '#B7B7B7' });
const OTHER_SHARE = 0.01; // owners holding less than this share of all outputs join Other exchanges

/**
 * Indices of the owners lit together as Other exchanges: those holding under 1% of all the
 * outputs in the owner data (owners.json entities[].records), when at least two do; else none.
 */
export function ownerGroup(entities) {
  const records = entities.map((e) => Number(e.records) || 0);
  const total = records.reduce((a, b) => a + b, 0);
  const members = total > 0 ? records.flatMap((n, i) => (n < total * OTHER_SHARE ? [i] : [])) : [];
  return members.length >= 2 ? members : [];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (iso) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
};
const span = (a, b) => (a && b && month(a) !== month(b) ? month(a) + ' to ' + month(b) : month(a || b));
// shortcut: names a host by the one dataset it serves in the owner data today; give evidence summaries
// a source name if a second dataset ever comes from the same host.
const SOURCE_NAMES = { 'raw.githubusercontent.com': 'DefiLlama', 'ndownloader.figshare.com': 'figshare' };

/**
 * Where an entity's addresses come from (owners.json entities[].evidence), as one line: the total,
 * then a clause per evidence type. An address can carry several types, so the clauses can add up
 * to more than the total.
 */
export function evidenceText(entity) {
  const parts = (entity.evidence || []).map((e) => {
    const n = fmtInt(e.addresses || 0);
    const when = span(e.firstObserved, e.lastObserved);
    const hosts = (e.sources || []).map((h) => escapeHtml(SOURCE_NAMES[h] || h)).join(', ');
    if (e.type === 'service_disclosure') return n + ' from its own published lists' + (when ? ', ' + when : '');
    if (e.type === 'service_disclosure_via_aggregator') return n + ' from its own wallet page, via ' + (hosts || 'an aggregator') + (when ? ', ' + when : '');
    const about = [hosts, when].filter(Boolean).join(', ');
    if (String(e.type).startsWith('service_disclosure')) return n + ' it announced' + (about ? ' (' + about + ')' : '');
    return n + ' that others attribute to it' + (hosts ? ' (' + hosts + ')' : '');
  });
  if (!parts.length) return [];
  const total = entity.addresses || 0;
  return [escapeHtml(entity.name) + ', ' + fmtInt(total) + (total === 1 ? ' address: ' : ' addresses: ') + parts.join('; ')];
}

/** The Other exchanges line of the sources: its exchanges, their addresses by kind, and their names. */
export function groupText(entities, members) {
  let total = 0;
  let own = 0;
  let others = 0;
  for (const i of members) {
    total += entities[i].addresses || 0;
    for (const e of entities[i].evidence || []) {
      if (String(e.type).startsWith('service_disclosure')) own += e.addresses || 0;
      else others += e.addresses || 0;
    }
  }
  const kinds = [own ? fmtInt(own) + ' they published or announced' : '', others ? fmtInt(others) + ' that others attribute to them' : ''].filter(Boolean);
  const names = members.map((i) => entities[i].name).sort((a, b) => a.localeCompare(b, 'en'));
  return escapeHtml(OTHER_OWNERS.name) + ', ' + fmtInt(members.length) + ' smaller exchanges lit together, ' + fmtInt(total) +
    (total === 1 ? ' address' : ' addresses') + (kinds.length ? ': ' + kinds.join('; ') : '') + ' (' + names.map(escapeHtml).join(', ') + ')';
}

/**
 * container: #owners; store: the settings store (owners.*); onToggle(id, on): show or hide an
 * entity, or every member of Other exchanges for OTHER_OWNERS.id. update({manifest, group (member
 * indices, see ownerGroup), visible: Set of ids, meta (frame meta.owners), block, loading}) refreshes it.
 */
export function createOwnersMenu({ container, store, onToggle }) {
  container.hidden = true;
  let state = null;
  let html = '';

  function render() {
    if (!state || !state.manifest) return;
    const { manifest, visible, meta, block, loading } = state;
    const group = state.group || [];
    const inGroup = new Set(group);
    const active = meta && meta.active;
    const past = Number.isInteger(block) && block > manifest.tip;
    // What the lit entities among these indices hold at the block.
    const held = (indices, on) => {
      if (!on) return '';
      if (!(active && meta.entities)) return loading ? 'Loading\u2026' : '';
      let count = 0;
      let sats = 0;
      for (const i of indices) {
        count += (meta.entities[i] && meta.entities[i].count) || 0;
        sats += (meta.entities[i] && meta.entities[i].sats) || 0;
      }
      return fmtInt(count) + ' outputs \u00b7 ' + fmtBtcTotal(sats);
    };
    const item = (id, name, color, on, text) => '<label class="ow-item' + (on ? ' on' : '') + '"><input type="checkbox" data-owner="' + escapeHtml(id) + '"' + (on ? ' checked' : '') + '>' +
      '<i class="ow-swatch" style="background:' + escapeHtml(color) + '"></i><span class="ow-name">' + name + '</span><span class="ow-held">' + text + '</span></label>';
    let rows = '';
    manifest.entities.forEach((e, i) => {
      if (inGroup.has(i)) return;
      const on = visible.has(e.id);
      rows += item(e.id, escapeHtml(e.name), e.color, on, held([i], on));
    });
    if (group.length) {
      const on = group.some((i) => visible.has(manifest.entities[i].id));
      rows += item(OTHER_OWNERS.id, escapeHtml(OTHER_OWNERS.name) + ' <span class="ow-n">' + fmtInt(group.length) + '</span>', OTHER_OWNERS.color, on, held(group, on));
    }
    const sources = manifest.entities.map((e, i) => {
      const lines = inGroup.has(i) ? [] : evidenceText(e);
      return lines.length ? '<li>' + lines.join('; ') + '.</li>' : '';
    }).join('') + (group.length ? '<li>' + groupText(manifest.entities, group) + '.</li>' : '');
    const dim = Number(store.get('owners.dim'));
    const pct = Math.round((Number.isFinite(dim) ? dim : 0.2) * 100);
    const only = !!store.get('owners.only');
    const flat = !!store.get('owners.flat');
    const out =
      '<div class="pl-col"><h3>Owners <span>Outputs paying addresses an exchange published or others attribute to it, lit in its colour at the current block. Only their spends flash.</span></h3>' +
      rows +
      '<label class="ow-check"><input type="checkbox" data-only' + (only ? ' checked' : '') + '><span>Hide the rest</span></label>' +
      '<label class="ow-check' + (only ? ' off' : '') + '"><input type="checkbox" data-flat' + (flat ? ' checked' : '') + (only ? ' disabled' : '') + '><span>Flatten the rest</span></label>' +
      '<label class="ow-dim' + (only ? ' off' : '') + '"><span>Dim the rest</span><input type="range" min="0" max="1" step="0.05" value="' + (pct / 100) + '" data-dim aria-label="Brightness of everything else"' + (only ? ' disabled' : '') + '>' +
      '<output>' + pct + '%</output></label>' +
      (past ? '<p class="ow-note">This block is after the owner data, which ends at block ' + fmtInt(manifest.tip) + '; nothing is lit here.</p>' : '') +
      '<ul class="ow-sources">' + sources + '<li>Only the exact outputs paying those addresses, from the block that created each to the block that spent it. Addresses others attribute to an exchange are reported, not confirmed by it, and most exchanges\u2019 deposit addresses and other wallets are missing, so this is a lower bound. Owner data runs through block ' + fmtInt(manifest.tip) + '.</li></ul></div>';
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
    if (e.target.matches('[data-flat]')) store.set('owners.flat', e.target.checked);
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
