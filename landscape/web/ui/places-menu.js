// Places popover (landscape/SPEC.md §8): landmarks of the unspent set (ui/places.js). The camera
// flies to the one chosen and the block stays; a place newer than the block goes to the latest block.

import { PLACES, placeFrom } from './places.js';

export function createPlacesMenu({ container, getBlock = () => null, onPlace }) {
  container.hidden = true;

  function render() {
    const block = getBlock();
    const items = PLACES.map((p) => {
      const later = Number.isInteger(block) && block < placeFrom(p);
      return '<button type="button" class="pl-item pl-place' + (later ? ' later' : '') + '" data-place="' + p.id + '"' +
        (later ? ' title="Newer than this block: goes to the latest block first"' : '') + '>' +
        '<span class="pl-key">' + p.name + '</span><span class="pl-meta">' + p.where + '</span>' +
        '<span class="pl-title">' + p.about + '</span></button>';
    }).join('');
    container.innerHTML =
      '<div class="pl-col"><h3>Places <span>Landmarks in the unspent set. The camera flies there; the block stays.</span></h3>' + items + '</div>';
  }
  render();

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-place]');
    if (!btn || btn.disabled) return;
    api.close();
    onPlace(btn.dataset.place);
  });
  const onDoc = (e) => {
    if (container.hidden) return;
    if (container.contains(e.target) || e.target.closest('[data-act="places"]')) return;
    api.close();
  };
  document.addEventListener('pointerdown', onDoc);

  const api = {
    get open() {
      return !container.hidden;
    },
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
