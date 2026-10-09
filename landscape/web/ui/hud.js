// Left HUD (landscape/SPEC.md §8): block, UTC date, playback speed and achieved
// blocks/s, totals of the exact state, the current block's activity and busy state.
// On phones (app.css) the HUD collapses to block, date and play state; the details button
// (hidden on larger screens) or a tap on the card shows the totals and the renderer line.

import { fmtInt, fmtBtcTotal, isoUtc, fmtRate, fmtCompact } from './format.js';

const PHASES = { init: 'Starting the replay worker', seek: 'Seeking', tiles: 'Loading tiles', advance: '', idle: '' };

function mb(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1048576).toLocaleString('en-US') + ' MB' : null;
}

export function createHud(container) {
  container.innerHTML =
    '<div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' +
    '<span>UTXO Timelapse <em>Landscape</em></span></div>' +
    '<div class="hud-block"><span class="eyebrow">Block</span><strong data-k="block">\u2014</strong></div>' +
    '<div class="hud-date" data-k="date">\u2014</div>' +
    '<div class="hud-play" data-k="play">\u2014</div>' +
    '<dl class="hud-stats">' +
    '<div><dt>Unspent outputs</dt><dd data-k="outputs">\u2014</dd></div>' +
    '<div><dt>Value</dt><dd data-k="value">\u2014</dd></div>' +
    '<div><dt>This block</dt><dd data-k="activity">\u2014</dd></div>' +
    '</dl>' +
    '<div class="hud-status" data-k="status" hidden><span class="pulse" aria-hidden="true"></span><span data-k="statusText"></span></div>' +
    '<div class="hud-foot" data-k="foot"></div>' +
    '<button type="button" class="hud-more" aria-expanded="false" aria-label="Show details" title="Details">' +
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  const el = {};
  container.querySelectorAll('[data-k]').forEach((n) => {
    el[n.dataset.k] = n;
  });
  const set = (k, v) => {
    if (el[k].textContent !== v) el[k].textContent = v;
  };
  const more = container.querySelector('.hud-more');
  const setExpanded = (open) => {
    container.classList.toggle('expanded', open);
    more.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-label', open ? 'Hide details' : 'Show details');
  };
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(!container.classList.contains('expanded'));
  });
  // The whole compact card is a large touch target; with the button hidden (desktop) a click does nothing.
  container.addEventListener('click', (e) => {
    if (more.offsetParent === null || e.target.closest('a, button')) return;
    setExpanded(!container.classList.contains('expanded'));
  });

  return {
    element: container,
    get expanded() {
      return container.classList.contains('expanded');
    },
    setExpanded,
    update({ block, meta, playback, status, backend, preset, scale }) {
      set('block', block == null ? '\u2014' : fmtInt(block));
      set('date', meta && meta.block === block && Number.isFinite(meta.time) ? isoUtc(meta.time, { withSeconds: true }) : '\u2014');
      let play = '\u2014';
      let limited = false;
      if (playback) {
        if (playback.scrubbing) play = 'Scrubbing';
        else if (playback.playing) {
          const rate = playback.achieved;
          play = '\u25b6 ' + playback.label + (rate != null ? ' \u00b7 ' + fmtRate(Math.max(0, rate)) : '');
          if (playback.limited) {
            play += ' \u00b7 worker-limited';
            limited = true;
          } else if (playback.policy === 'snapshot') play += ' \u00b7 snapshot steps';
          else if (playback.policy === 'exact') play += ' \u00b7 exact';
        } else play = 'Paused \u00b7 ' + playback.label;
      }
      set('play', play);
      el.play.classList.toggle('warn', limited);
      const t = meta && meta.totals;
      if (t) {
        set('outputs', fmtInt(t.countSmall + t.countLarge));
        set('value', fmtBtcTotal(t.satsSmall + t.satsLarge));
      }
      if (meta && meta.block === block && Number.isFinite(meta.nTx)) {
        set('activity', fmtInt(meta.nTx) + ' tx \u00b7 +' + fmtInt(meta.created) + ' \u2212' + fmtInt(meta.spent));
      }
      let busyText = '';
      if (status && status.busy) {
        busyText = PHASES[status.phase] ?? status.phase ?? '';
        if (status.phase === 'seek' && Number.isFinite(status.target)) busyText += ' ' + fmtInt(status.target);
        if (status.phase === 'tiles' && status.pendingTiles) busyText = 'Loading ' + fmtInt(status.pendingTiles) + ' tiles';
        if (busyText && Number.isFinite(status.progress)) busyText += ' \u00b7 ' + Math.round(status.progress * 100) + '%';
      }
      el.status.hidden = !busyText;
      set('statusText', busyText);
      const foot = [backend === 'webgl2' ? 'WebGL2' : backend === 'webgpu' ? 'WebGPU' : null, preset || null];
      if (Number.isFinite(scale)) foot.push(scale.toFixed(2) + '\u00d7 res');
      if (status && Number.isFinite(status.residentTiles)) foot.push(fmtCompact(status.residentTiles) + (status.residentTiles === 1 ? ' tile' : ' tiles'));
      const m = status && mb(status.memoryBytes);
      if (m) foot.push('worker ' + m);
      set('foot', foot.filter(Boolean).join(' \u00b7 '));
    },
  };
}
