// Fun menu (landscape/SPEC.md §8), opened by the timeline's Fun button: choose the craft
// (plane, bird or jet; remembered, the menu stays open) and take off in free flight or start
// Stack sats, which shows the current craft's best stack. Plus the Stack sats end card, shown
// when a run's minute is up: the stack, the coins, the best for that craft and Again / Land.

import { CRAFT_ORDER, craftSpec } from './plane.js';
import { fmtStack } from './stack-sats.js';
import { escapeHtml } from './format.js';

export const CRAFT_BLURBS = Object.freeze({
  plane: 'Steady; banks to turn',
  bird: 'Slow and nimble; flaps and hugs the ground',
  jet: 'Fast and wide; afterburner',
});

/**
 * container: #fun. getCraft() -> craft id; getBest(craft) -> { sats, coins } or null;
 * onCraft(id) when a craft is chosen; onPlay('free' | 'stack-sats') after the menu closes.
 */
export function createFunMenu({ container, getCraft, getBest, onCraft, onPlay }) {
  container.hidden = true;

  function render() {
    const current = getCraft();
    const crafts = CRAFT_ORDER.map((id) => {
      const on = id === current;
      return '<button type="button" class="pl-item fn-craft' + (on ? ' on' : '') + '" data-craft="' + id + '" aria-pressed="' + on + '">' +
        '<span class="pl-key">' + craftSpec(id).name + '</span><span class="pl-title">' + CRAFT_BLURBS[id] + '</span>' +
        '<span class="pl-meta">' + (on ? 'chosen' : '') + '</span></button>';
    }).join('');
    const best = getBest(current);
    const play =
      '<button type="button" class="pl-item fn-play" data-play="free"><span class="pl-key">Free flight</span>' +
      '<span class="pl-title">Fly anywhere, time keeps running</span><span class="pl-meta">T</span></button>' +
      '<button type="button" class="pl-item fn-play" data-play="stack-sats"><span class="pl-key">Stack sats</span>' +
      '<span class="pl-title">60 s to follow coin trails and grab coins on the tallest columns; each is worth its row\u2019s amount</span>' +
      '<span class="pl-meta">' + (best ? 'Best ' + escapeHtml(fmtStack(best.sats)) : 'No stack yet') + '</span></button>';
    container.innerHTML =
      '<div class="pl-col"><h3>Craft <span>how it flies</span></h3>' + crafts + '</div>' +
      '<div class="pl-col"><h3>Play <span>takes off from the centre of the view</span></h3>' + play + '</div>' +
      '<p class="fn-foot">Esc lands \u00b7 C changes craft in flight \u00b7 Enter starts Stack sats</p>';
  }
  render();

  container.addEventListener('click', (e) => {
    const craftBtn = e.target.closest('[data-craft]');
    if (craftBtn) {
      onCraft(craftBtn.dataset.craft);
      render();
      const again = container.querySelector('[data-craft="' + craftBtn.dataset.craft + '"]');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    const playBtn = e.target.closest('[data-play]');
    if (!playBtn) return;
    api.close();
    onPlay(playBtn.dataset.play);
  });
  const onDoc = (e) => {
    if (container.hidden) return;
    if (container.contains(e.target) || e.target.closest('[data-act="fun"]')) return;
    api.close();
  };
  document.addEventListener('pointerdown', onDoc);

  const api = {
    get open() {
      return !container.hidden;
    },
    render,
    toggle() {
      if (container.hidden) render();
      container.hidden = !container.hidden;
    },
    close() {
      container.hidden = true;
    },
  };
  return api;
}

/** container: #funcard. onAgain() and onLand() from its buttons. */
export function createFunCard({ container, onAgain, onLand }) {
  container.hidden = true;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-card]');
    if (!btn) return;
    if (btn.dataset.card === 'again') onAgain();
    else onLand();
  });
  return {
    get open() {
      return !container.hidden;
    },
    /** result: { sats, coins, seconds, craft, best: { sats } | null, isBest }. */
    show({ sats, coins, seconds = 60, craft, best, isBest }) {
      const name = craftSpec(craft).name;
      const bestLine = isBest ? 'New best with the ' + name
        : best ? 'Best with the ' + name + ': ' + fmtStack(best.sats) : 'No stack with the ' + name + ' yet';
      container.innerHTML =
        '<span class="eyebrow">Stack sats \u00b7 ' + escapeHtml(name) + '</span>' +
        '<h2>Stacked <em>' + escapeHtml(fmtStack(sats)) + '</em></h2>' +
        '<p class="fc-sub">in ' + seconds + ' s \u00b7 ' + coins + (coins === 1 ? ' coin' : ' coins') + '</p>' +
        '<p class="fc-best' + (isBest ? ' new' : '') + '">' + escapeHtml(bestLine) + '</p>' +
        '<div class="fc-actions"><button type="button" class="fc-btn primary" data-card="again">Again <kbd>Enter</kbd></button>' +
        '<button type="button" class="fc-btn" data-card="land">Land <kbd>Esc</kbd></button></div>';
      container.hidden = false;
    },
    hide() {
      container.hidden = true;
    },
  };
}
