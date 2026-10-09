// Startup screen: phase text and progress until the first real frame; then a fatal
// error card with concrete next steps if startup fails.

import { escapeHtml, fmtInt } from './format.js';

export function createLoading(root) {
  const status = root.querySelector('.loading-status');
  const detail = root.querySelector('.loading-detail');
  const bar = root.querySelector('.loading-bar span');
  let done = false;
  return {
    set(text, progress = null) {
      if (done) return;
      status.textContent = text;
      bar.style.width = progress == null ? '' : Math.round(progress * 100) + '%';
      root.classList.toggle('indeterminate', progress == null);
    },
    status(s) {
      if (done || !s) return;
      const parts = [];
      if (s.message) parts.push(s.message);
      if (Number.isFinite(s.pendingTiles) && s.pendingTiles > 0) parts.push(fmtInt(s.pendingTiles) + ' tiles pending');
      if (Number.isFinite(s.residentTiles)) parts.push(fmtInt(s.residentTiles) + ' resident');
      detail.textContent = parts.join(' \u00b7 ');
      if (s.phase === 'seek') this.set('Replaying to block ' + (Number.isFinite(s.target) ? fmtInt(s.target) : '\u2026'), Number.isFinite(s.progress) ? s.progress : null);
      else if (s.phase === 'tiles') this.set('Loading tiles', Number.isFinite(s.progress) ? s.progress : null);
    },
    done() {
      if (done) return;
      done = true;
      root.classList.add('done');
      setTimeout(() => {
        root.hidden = true;
      }, 500);
    },
    /** A non-fatal problem while still loading (e.g. the renderer keeps failing). */
    problem(text) {
      if (done) return;
      detail.textContent = text;
      detail.classList.add('problem');
    },
    fatal(title, html) {
      done = true;
      root.hidden = false;
      root.classList.remove('done');
      root.classList.add('fatal');
      root.querySelector('.loading-card').innerHTML =
        '<div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span>UTXO Timelapse <em>Landscape</em></span></div>' +
        '<h1>' + escapeHtml(title) + '</h1>' + html;
    },
  };
}
