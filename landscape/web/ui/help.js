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
    [['1', '2', '3', '4'], 'Speed 1\u00d7, 2\u00d7, 5\u00d7, Max; 1\u00d7 is 60 blocks, about 10 hours of Bitcoin, every second'],
    [['N'], 'Follow the tip (the Follow button): the camera moves with the newest block, while playing and when you scrub or step, and you can still pan, orbit and zoom; N again stops'],
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
  ['Fly', [
    [['F', '~Fly button'], 'Enter or leave flight mode'],
    [['~Mouse'], 'Look (drag when pointer lock is unavailable)'],
    [['W', 'A', 'S', 'D'], 'Fly; Shift for 4\u00d7'],
    [['E', 'Q'], 'Up and down'],
    [['~Wheel'], 'Flight speed'],
    [['I'], 'Inspect the cell at the crosshair'],
    [['Esc'], 'Back to map mode'],
  ]],
  ['Fun', [
    [['~Fun button'], 'Choose a plane, a bird or a jet; fly free or play Stack sats'],
    [['T'], 'Take off from the centre of the view; T again lands in map mode'],
    [['C'], 'Next craft: plane, bird, jet (also in flight)'],
    [['Enter'], 'Stack sats: 60 s to collect coins over the tallest columns, each worth its row\u2019s amount'],
    [['~Mouse'], 'Stick that springs back: sideways banks, back raises the nose (Invert Y switches it)'],
    [['A', 'D', '\u2190', '\u2192'], 'Bank left or right; the bank turns the craft'],
    [['\u2193', '\u2191'], 'Nose up or down; back in a bank tightens the turn'],
    [['W', 'S'], 'Faster or slower; hold Shift to boost'],
    [['~Wheel'], 'Camera closer or farther'],
    [['M'], 'Engine sound on or off'],
    [['Esc'], 'Back to map mode'],
  ], { flyOnly: true }],
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
  // Touch-only devices have no plane mode (Fun), so its keys are left out there.
  const sections = SECTIONS.filter((s) => !(touchFirst && s[2] && s[2].flyOnly));
  const list = touchFirst ? [TOUCH, ...sections] : [...sections, TOUCH];
  const html = list.map(([title, rows]) =>
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
    '<div class="help-grid">' + html + '</div>' +
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
