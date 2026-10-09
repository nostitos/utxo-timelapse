// Touch, keyboard and mouse reference plus the about/credit line, shown in <dialog id="help">.

// Each entry: [keys or gestures, description]. Strings starting with '~' are gestures.
const TOUCH = ['Touch', [
  [['~One finger'], 'Pan; the ground stays under your finger'],
  [['~Pinch'], 'Zoom around your fingers'],
  [['~Twist'], 'Rotate'],
  [['~Two fingers up or down'], 'Tilt'],
  [['~Tap'], 'Inspect the cell'],
  [['~Double-tap'], 'Fly closer; keep the second tap down and drag to zoom'],
  [['~Two-finger tap'], 'Zoom out'],
]];

const SECTIONS = [
  ['Time', [
    [['Space'], 'Play or pause'],
    [['[', ']'], 'Back or forward 1 block (exact)'],
    [['Shift', '[', ']'], 'Back or forward 1,008 blocks (about a week)'],
    [['1', '2', '3', '4'], 'Speed 1\u00d7, 10\u00d7, 100\u00d7, Max'],
  ]],
  ['Map mode', [
    [['~Drag'], 'Pan; the grabbed point stays under the cursor'],
    [['~Right-drag', 'Shift'], 'Orbit around the point under the cursor'],
    [['~Wheel', '~Trackpad pinch'], 'Zoom toward the cursor'],
    [['~Double-click'], 'Fly to that point'],
    [['~Click', 'I'], 'Inspect the cell under the cursor'],
    [['\u2190', '\u2191', '\u2192', '\u2193'], 'Pan (Shift for 4\u00d7)'],
    [['Q', 'E'], 'Rotate around the screen centre'],
    [['PgUp', 'PgDn'], 'Tilt'],
  ]],
  ['Flight mode', [
    [['F'], 'Enter or leave flight mode'],
    [['~Mouse'], 'Look (drag when pointer lock is unavailable)'],
    [['W', 'A', 'S', 'D'], 'Fly; Shift for 4\u00d7'],
    [['E', 'Q'], 'Up and down'],
    [['~Wheel'], 'Flight speed'],
    [['I'], 'Inspect the cell at the crosshair'],
    [['Esc'], 'Back to map mode'],
  ]],
  ['Panels', [
    [['G'], 'Graphics settings'],
    [['P'], 'Places'],
    [['H', '?'], 'This help'],
    [['Esc'], 'Close the inspector or a panel'],
  ]],
];

function keyHtml(k) {
  return k.startsWith('~') ? '<span class="gesture">' + k.slice(1) + '</span>' : '<kbd>' + k + '</kbd>';
}

/** touchFirst puts the touch gestures first (phones and tablets without a mouse). */
export function createHelp(dialog, { touchFirst = false } = {}) {
  const list = touchFirst ? [TOUCH, ...SECTIONS] : [...SECTIONS, TOUCH];
  const sections = list.map(([title, rows]) =>
    '<section><h3>' + title + '</h3><dl>' +
    rows.map(([keys, v]) => '<div><dt>' + keys.map(keyHtml).join('') + '</dt><dd>' + v + '</dd></div>').join('') +
    '</dl></section>').join('');
  dialog.innerHTML =
    '<div class="help-head"><div><span class="eyebrow">UTXO Timelapse \u00b7 Landscape</span>' +
    '<h2>Every unspent output, <em>in three dimensions.</em></h2></div>' +
    '<button type="button" class="icon-btn" data-close aria-label="Close help">\u00d7</button></div>' +
    '<p class="help-lead">Left to right: the block that created each output, one column per 64 blocks. ' +
    'Front to back: its amount, on the film\u2019s 2,072 rows, with the largest amounts farthest away. ' +
    'Height and colour measure the outputs still unspent at the current block. ' +
    'Your browser replays that state exactly from the change log, block by block.</p>' +
    '<div class="help-grid">' + sections + '</div>' +
    '<p class="help-credit">Original concept and code by <a href="https://github.com/martinus/BitcoinUtxoVisualizer" target="_blank" rel="noopener">Martinus</a> ' +
    '(BitcoinUtxoVisualizer, MIT licence). The landscape, the exact browser replay and this interface are part of UTXO Timelapse.</p>';
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  return {
    get open() {
      return dialog.open;
    },
    toggle() {
      if (dialog.open) dialog.close();
      else dialog.showModal();
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
