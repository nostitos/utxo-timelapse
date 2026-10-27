import { buildShareUrl } from './share-link.js';
import { fmtInt } from './format.js';

export const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M5 11v9h14v-9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createShare({ dialog, getSnapshot }) {
  let snapshot = null, trigger = null, autoplay = false;
  dialog.innerHTML = '<div class="share-head"><div><span class="eyebrow">UTXO Timelapse · Landscape</span><h2 id="share-title">Share this view</h2></div><button class="icon-btn" type="button" data-close aria-label="Close share dialog">×</button></div>' +
    '<fieldset class="share-modes"><legend>What to share</legend>' +
    '<label><input type="radio" name="landscape-share" value="view" checked><span><strong>Current view</strong><small>Location, block and appearance</small></span></label>' +
    '<label><input type="radio" name="landscape-share" value="cell"><span><strong>Selected cell</strong><small data-cell-hint>Select a cell first</small></span></label></fieldset>' +
    '<div class="share-summary"><strong data-block></strong><p data-context></p></div>' +
    '<label class="share-play"><span><strong>Autoplay</strong><small data-play-hint>Start playing when the link is opened.</small></span><input type="checkbox" role="switch" aria-label="Autoplay"></label>' +
    '<label class="share-link-label" for="share-url">Link to this view</label><div class="share-link-row"><textarea id="share-url" readonly rows="3" spellcheck="false"></textarea><button type="button" data-copy>Copy link</button></div>' +
    '<p class="share-status" role="status" aria-live="polite"></p><p class="share-local" hidden>This local preview link works on this computer.</p>' +
    '<div class="share-destinations"><a data-x target="_blank" rel="noopener noreferrer">X.com ↗</a><a data-email>Email</a><button type="button" data-native hidden>More options</button></div>';
  const q = s => dialog.querySelector(s);
  const viewMode = q('[value="view"]'), cellMode = q('[value="cell"]');
  const play = q('[role="switch"]'), field = q('textarea'), status = q('.share-status'), copy = q('[data-copy]');
  q('[data-native]').hidden = typeof navigator.share !== 'function';
  const title = () => 'Bitcoin Landscape · block ' + fmtInt(snapshot.block) + (cellMode.checked ? ' · selected cell' : '');

  function update() {
    if (!snapshot) return;
    const cell = cellMode.checked && snapshot.cell;
    play.disabled = !!cell;
    play.checked = !cell && autoplay;
    q('[data-play-hint]').textContent = cell ? 'Cell links open paused, with their details visible.' : 'Start playing when the link is opened.';
    q('[data-block]').textContent = 'Block ' + fmtInt(snapshot.block);
    q('[data-context]').textContent = cell ? snapshot.cellDescription : snapshot.date + ' · Same camera and appearance';
    field.value = buildShareUrl(location.href, snapshot, { selectedCell: !!cell, autoplay: play.checked });
    field.setSelectionRange(0, 0);
    field.scrollTop = 0;
    q('[data-x]').href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(title()) + '&url=' + encodeURIComponent(field.value);
    q('[data-email]').href = 'mailto:?subject=' + encodeURIComponent(title()) + '&body=' + encodeURIComponent(field.value);
    q('.share-local').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    status.textContent = '';
    copy.textContent = 'Copy link';
  }
  for (const radio of [viewMode, cellMode]) radio.addEventListener('change', update);
  play.addEventListener('change', () => { autoplay = play.checked; update(); });
  q('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', e => e.stopPropagation());
  dialog.addEventListener('click', e => {
    const r = dialog.getBoundingClientRect();
    if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => {
    snapshot = null;
    const target = trigger?.isConnected ? trigger : document.querySelector('[data-act="share"]');
    target?.focus({ preventScroll: true });
  });
  copy.addEventListener('click', async () => {
    const url = field.value;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      if (dialog.open && field.value === url) { copy.textContent = 'Copied'; status.textContent = 'Link copied to clipboard.'; }
    } catch {
      if (!dialog.open || field.value !== url) return;
      copy.textContent = 'Copy link';
      field.focus(); field.select();
      status.textContent = 'Select and copy the link above; clipboard access is unavailable here.';
    }
  });
  q('[data-native]').addEventListener('click', async () => {
    try { await navigator.share({ title: title(), url: field.value }); }
    catch (e) { if (e.name !== 'AbortError') status.textContent = 'Sharing is unavailable here. You can copy the link.'; }
  });
  return {
    get open() { return dialog.open; },
    openDialog(mode = 'view') {
      trigger = document.activeElement?.matches('[data-share-cell], [data-act="share"]') ? document.activeElement : document.querySelector(mode === 'cell' ? '[data-share-cell]' : '[data-act="share"]');
      snapshot = getSnapshot();
      autoplay = snapshot.playing;
      cellMode.disabled = !snapshot.cell;
      cellMode.checked = mode === 'cell' && !!snapshot.cell;
      viewMode.checked = !cellMode.checked;
      q('[data-cell-hint]').textContent = snapshot.cell ? 'Open the same cell and its details' : 'Select a cell first';
      update();
      dialog.showModal();
      (cellMode.checked ? cellMode : viewMode).focus();
    },
    close() { if (dialog.open) dialog.close(); },
  };
}
