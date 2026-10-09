// Places popover (landscape/SPEC.md §8): eras seek and fly to that creation column;
// amount bands fly to that row.

import { ERAS, BANDS, eraBlock, bandRows } from './places.js';
import { fmtInt, isoUtc } from './format.js';

export function createPlacesMenu({ container, tip, blocktimes, rows, onPlace }) {
  let tipBlock = tip;
  container.hidden = true;

  function render() {
    const eraItems = ERAS.map((e) => {
      const b = eraBlock(e, tipBlock);
      const beyond = e.block !== 'tip' && e.block > tipBlock;
      return '<button type="button" class="pl-item" data-place="' + e.id + '"' + (beyond ? ' disabled title="After this dataset\u2019s tip"' : '') + '>' +
        '<span class="pl-key">' + (e.block === 'tip' ? 'Tip' : fmtInt(e.block)) + '</span>' +
        '<span class="pl-title">' + e.title + '</span>' +
        '<span class="pl-meta">' + (!beyond && Number.isFinite(blocktimes[b]) ? isoUtc(blocktimes[b], { time: false }) : 'after tip') + '</span></button>';
    }).join('');
    const bandItems = BANDS.map((band) => {
      const r = rows ? bandRows(rows, band) : null;
      const span = r ? (r.rowMin === r.rowMax ? 'row ' + fmtInt(r.rowMin) : 'rows ' + fmtInt(r.rowMin) + '\u2013' + fmtInt(r.rowMax)) : '';
      return '<button type="button" class="pl-item" data-place="' + band.id + '">' +
        '<span class="pl-key">' + band.label + '</span><span class="pl-title"></span><span class="pl-meta">' + span + '</span></button>';
    }).join('');
    container.innerHTML =
      '<div class="pl-col"><h3>Eras <span>seek and fly to the creation edge</span></h3>' + eraItems + '</div>' +
      '<div class="pl-col"><h3>Amount bands <span>fly to the row</span></h3>' + bandItems + '</div>';
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
    setTip(t) {
      tipBlock = t;
      render();
    },
    toggle() {
      container.hidden = !container.hidden;
    },
    close() {
      container.hidden = true;
    },
  };
  return api;
}
