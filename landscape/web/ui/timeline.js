// Bottom timeline (landscape/SPEC.md §8): transport, speeds, scrubber with halving
// marks, exact block input, UTC date input, and the Places / Settings / Help buttons.

import { SPEEDS, STEP_LARGE } from './playback.js';
import { dateToBlock, parseUtc } from './time.js';
import { fmtInt, isoUtc } from './format.js';

const ICONS = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h2.8v11H4zM9.2 2.5H12v11H9.2z"/></svg>',
  back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 3v10L5 8z"/><path d="M3.2 3h1.6v10H3.2z"/></svg>',
  fwd: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10l7-5z"/><path d="M11.2 3h1.6v10h-1.6z"/></svg>',
  backLarge: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10L1.5 8zM15 3v10L8.5 8z"/></svg>',
  fwdLarge: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3v10l6.5-5zM8 3v10l6.5-5z"/></svg>',
};
const HALVINGS = [210000, 420000, 630000, 840000];

export function createTimeline({ container, tip, blocktimes, playback, onSeek, onNotice, onPlaces, onSettings, onHelp }) {
  let tipBlock = tip;
  container.innerHTML =
    '<div class="tl-transport">' +
    '<button type="button" class="tl-btn" data-act="backLarge" title="Back ' + fmtInt(STEP_LARGE) + ' blocks (Shift+[)" aria-label="Back ' + fmtInt(STEP_LARGE) + ' blocks">' + ICONS.backLarge + '</button>' +
    '<button type="button" class="tl-btn" data-act="back" title="Back 1 block ([)" aria-label="Back 1 block">' + ICONS.back + '</button>' +
    '<button type="button" class="tl-btn tl-play" data-act="play" title="Play or pause (Space)" aria-label="Play">' + ICONS.play + '</button>' +
    '<button type="button" class="tl-btn" data-act="fwd" title="Forward 1 block (])" aria-label="Forward 1 block">' + ICONS.fwd + '</button>' +
    '<button type="button" class="tl-btn" data-act="fwdLarge" title="Forward ' + fmtInt(STEP_LARGE) + ' blocks (Shift+])" aria-label="Forward ' + fmtInt(STEP_LARGE) + ' blocks">' + ICONS.fwdLarge + '</button>' +
    '</div>' +
    '<div class="tl-speeds" role="radiogroup" aria-label="Playback speed">' +
    SPEEDS.map((s, i) => '<button type="button" role="radio" data-speed="' + s.id + '" title="' + s.label + ' (' + (i + 1) + ')">' + s.label + '</button>').join('') +
    '</div>' +
    '<div class="tl-track"><div class="tl-marks" aria-hidden="true"></div>' +
    '<input type="range" class="tl-scrub" min="0" max="' + tipBlock + '" step="1" value="0" aria-label="Block (drag to scrub)"></div>' +
    '<label class="tl-field tl-blockfield"><span>Block</span><input type="number" class="tl-block" min="0" max="' + tipBlock + '" step="1" inputmode="numeric" aria-label="Block height"></label>' +
    '<label class="tl-field tl-datefield"><span>UTC</span><input type="text" class="tl-date" spellcheck="false" autocomplete="off" placeholder="YYYY-MM-DD HH:MM" aria-label="Date and time, UTC (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)"></label>' +
    '<div class="tl-tools">' +
    '<button type="button" class="tl-text" data-act="places" title="Places (P)" aria-haspopup="true">Places</button>' +
    '<button type="button" class="tl-text" data-act="settings" title="Graphics settings (G)">Settings</button>' +
    '<button type="button" class="tl-text tl-round" data-act="help" title="Keyboard and mouse (H or ?)" aria-label="Help">?</button>' +
    '</div>';

  const q = (s) => container.querySelector(s);
  const scrub = q('.tl-scrub');
  const blockInput = q('.tl-block');
  const dateInput = q('.tl-date');
  const playBtn = q('[data-act="play"]');
  const marks = q('.tl-marks');
  const speedBtns = [...container.querySelectorAll('[data-speed]')];
  let dragging = false;
  let shown = { block: null, playing: null, speed: null };

  function renderMarks() {
    const items = HALVINGS.filter((h) => h <= tipBlock).map((h, i) =>
      '<span class="tl-mark" style="left:' + ((h / tipBlock) * 100).toFixed(4) + '%" title="Halving ' + (i + 1) + ' \u00b7 block ' + fmtInt(h) + '"></span>');
    marks.innerHTML = items.join('');
  }
  renderMarks();

  const actions = {
    play: () => playback.toggle(),
    back: () => playback.step(-1),
    fwd: () => playback.step(1),
    backLarge: () => playback.step(-STEP_LARGE),
    fwdLarge: () => playback.step(STEP_LARGE),
    places: () => onPlaces && onPlaces(q('[data-act="places"]')),
    settings: () => onSettings && onSettings(),
    help: () => onHelp && onHelp(),
  };
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !container.contains(btn)) return;
    if (btn.dataset.speed) playback.setSpeed(btn.dataset.speed);
    else if (actions[btn.dataset.act]) actions[btn.dataset.act]();
    btn.blur();
  });

  scrub.addEventListener('pointerdown', () => {
    dragging = true;
  });
  scrub.addEventListener('input', () => {
    dragging = true;
    playback.scrubTo(Number(scrub.value));
  });
  scrub.addEventListener('change', () => {
    dragging = false;
    playback.scrubEnd(Number(scrub.value));
    scrub.blur();
  });
  const endDrag = () => {
    if (dragging && !playback.state.scrubbing) dragging = false;
  };
  window.addEventListener('pointerup', endDrag);

  function commitBlock() {
    const v = blockInput.value.trim();
    if (!/^\d+$/.test(v)) {
      if (onNotice) onNotice('Enter a block height from 0 to ' + fmtInt(tipBlock), 'warn');
      return;
    }
    const b = Math.min(Number(v), tipBlock);
    onSeek(b);
    blockInput.blur();
  }
  blockInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitBlock();
    if (e.key === 'Escape') blockInput.blur();
  });
  blockInput.addEventListener('change', commitBlock);

  function commitDate() {
    const t = parseUtc(dateInput.value);
    if (t == null) {
      if (onNotice) onNotice('Enter a UTC date such as 2014-08-04 or 2014-08-04 14:30', 'warn');
      return;
    }
    const b = dateToBlock(blocktimes, t, tipBlock + 1);
    if (b == null) {
      if (onNotice) onNotice('That date is after the last block in this dataset', 'warn');
      return;
    }
    onSeek(b);
    dateInput.blur();
  }
  dateInput.addEventListener('change', commitDate);
  dateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitDate();
    if (e.key === 'Escape') dateInput.blur();
  });

  return {
    element: container,
    get dragging() {
      return dragging;
    },
    setTip(t) {
      tipBlock = t;
      scrub.max = String(t);
      blockInput.max = String(t);
      renderMarks();
    },
    update(block, state) {
      if (block != null && block !== shown.block) {
        if (!dragging) scrub.value = String(block);
        if (document.activeElement !== blockInput) blockInput.value = String(block);
        if (document.activeElement !== dateInput) dateInput.value = isoUtc(blocktimes[block], { withSeconds: true }).replace(' UTC', '');
        shown.block = block;
        scrub.style.setProperty('--fill', ((block / Math.max(1, tipBlock)) * 100).toFixed(3) + '%');
      }
      if (state && state.playing !== shown.playing) {
        playBtn.innerHTML = state.playing ? ICONS.pause : ICONS.play;
        playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
        playBtn.classList.toggle('on', state.playing);
        shown.playing = state.playing;
      }
      if (state && state.speed !== shown.speed) {
        speedBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.speed === state.speed)));
        shown.speed = state.speed;
      }
    },
  };
}
