// Bottom timeline (landscape/SPEC.md §8): transport, speeds, scrubber with halving
// marks, exact block input, UTC date input, and the Follow / Fly / Fun / Sound / Places /
// Settings / Help buttons (Follow toggles Follow tip, Fly flight mode and Sound the sound
// switch, and all three show their state; Fun opens the Fun menu of crafts and Stack sats.
// Fly and Fun only when onFly and onFun are given: touch-only devices leave them out).
// On phones (app.css) the block and date inputs hide, Places and Settings show icons, and
// narrow screens replace the speed buttons with one button that cycles through the speeds.

import { SPEEDS, STEP_LARGE, speedById, speedHint } from './playback.js';
import { dateToBlock, parseUtc } from './time.js';
import { fmtInt, isoUtc } from './format.js';

const ICONS = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h2.8v11H4zM9.2 2.5H12v11H9.2z"/></svg>',
  back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 3v10L5 8z"/><path d="M3.2 3h1.6v10H3.2z"/></svg>',
  fwd: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10l7-5z"/><path d="M11.2 3h1.6v10h-1.6z"/></svg>',
  backLarge: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10L1.5 8zM15 3v10L8.5 8z"/></svg>',
  fwdLarge: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3v10l6.5-5zM8 3v10l6.5-5z"/></svg>',
  places: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 .9a5.1 5.1 0 0 0-5.1 5.1c0 3.9 5.1 9.1 5.1 9.1s5.1-5.2 5.1-9.1A5.1 5.1 0 0 0 8 .9zm0 7.1a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>',
  settings: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M6.13 2.72L6.55 .85h2.9l.42 1.87.54.23 1.62-1.03 2.05 2.05-1.03 1.62.23.54 1.87.42v2.9l-1.87.42-.23.54 1.03 1.62-2.05 2.05-1.62-1.03-.54.23-.42 1.87h-2.9l-.42-1.87-.54-.23-1.62 1.03-2.05-2.05 1.03-1.62-.23-.54L.85 9.45v-2.9l1.87-.42.23-.54-1.03-1.62 2.05-2.05 1.62 1.03zM10.3 8a2.3 2.3 0 1 0-4.6 0 2.3 2.3 0 0 0 4.6 0z"/></svg>',
  fly: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 7.4 14.6 1.4 8.6 14.4 7.3 8.7z"/></svg>',
  fun: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .8c.55 0 .95.5.95 1.2v4.1l6 3.3v1.6L8.95 9.2v3.2l1.75 1.3v1.3L8 14.2 5.3 15v-1.3l1.75-1.3V9.2L1.05 11V9.4l6-3.3V2c0-.7.4-1.2.95-1.2z"/></svg>',
  follow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 7.2h6.9V3.9L12.4 8l-4.5 4.1V8.8H1z"/><path d="M13.4 2.2H15v11.6h-1.6z"/></svg>',
  sound: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 5.6h2.7L8 2.4v11.2L4.2 10.4H1.5z"/><path d="M10.2 5.2a3.6 3.6 0 0 1 0 5.6l-.9-1.1a2.2 2.2 0 0 0 0-3.4z"/><path d="M11.9 3a6.4 6.4 0 0 1 0 10l-.9-1.1a5 5 0 0 0 0-7.8z"/></svg>',
};
const HALVINGS = [210000, 420000, 630000, 840000];
const speedLabel = (id) => (SPEEDS.find((s) => s.id === id) || { label: String(id) }).label;

export function createTimeline({ container, tip, blocktimes, playback, onSeek, onNotice, onPlaces, onSettings, onHelp, onFollow = null, onFly = null, onFun = null, onSound = null }) {
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
    SPEEDS.map((s, i) => '<button type="button" role="radio" data-speed="' + s.id + '" title="' + speedHint(s) + ' (key ' + (i + 1) + ')">' + s.label + '</button>').join('') +
    '</div>' +
    '<button type="button" class="tl-speedcycle" data-act="speed" title="Playback speed (1 to 4)">' + SPEEDS[0].label + '</button>' +
    '<div class="tl-track"><div class="tl-marks" aria-hidden="true"></div>' +
    '<input type="range" class="tl-scrub" min="0" max="' + tipBlock + '" step="1" value="0" aria-label="Block (drag to scrub)"></div>' +
    '<label class="tl-field tl-blockfield"><span>Block</span><input type="number" class="tl-block" min="0" max="' + tipBlock + '" step="1" inputmode="numeric" aria-label="Block height"></label>' +
    '<label class="tl-field tl-datefield"><span>UTC</span><input type="text" class="tl-date" spellcheck="false" autocomplete="off" placeholder="YYYY-MM-DD HH:MM" aria-label="Date and time, UTC (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)"></label>' +
    '<div class="tl-tools">' +
    (onFollow ? '<button type="button" class="tl-text" data-act="follow" aria-pressed="false" title="Follow the tip: the camera moves with the newest block (N)">' + ICONS.follow + '<span class="tl-label">Follow</span></button>' : '') +
    (onFly ? '<button type="button" class="tl-text" data-act="fly" aria-pressed="false" title="Fly: mouse to look, W A S D to move (F)">' + ICONS.fly + '<span class="tl-label">Fly</span></button>' : '') +
    (onFun ? '<button type="button" class="tl-text" data-act="fun" aria-haspopup="true" title="Fun: fly a plane, bird or jet, and stack sats (T takes off)">' + ICONS.fun + '<span class="tl-label">Fun</span></button>' : '') +
    (onSound ? '<button type="button" class="tl-text" data-act="sound" aria-pressed="false" title="Sound: a click for each spend flash on screen, darker for older coins, louder for more BTC and nearer the view; the engine in plane mode (M)">' + ICONS.sound + '<span class="tl-label">Sound</span></button>' : '') +
    '<button type="button" class="tl-text" data-act="places" title="Places (P)" aria-haspopup="true">' + ICONS.places + '<span class="tl-label">Places</span></button>' +
    '<button type="button" class="tl-text" data-act="settings" title="Graphics settings (G)">' + ICONS.settings + '<span class="tl-label">Settings</span></button>' +
    '<button type="button" class="tl-text tl-round" data-act="help" title="Keyboard and mouse (H or ?)" aria-label="Help">?</button>' +
    '</div>';

  const q = (s) => container.querySelector(s);
  const scrub = q('.tl-scrub');
  const blockInput = q('.tl-block');
  const dateInput = q('.tl-date');
  const playBtn = q('[data-act="play"]');
  const speedCycle = q('[data-act="speed"]');
  const followBtn = q('[data-act="follow"]');
  const flyBtn = q('[data-act="fly"]');
  const soundBtn = q('[data-act="sound"]');
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
    speed: () => {
      const i = SPEEDS.findIndex((s) => s.id === playback.state.speed);
      playback.setSpeed(SPEEDS[(i + 1) % SPEEDS.length].id);
    },
    places: () => onPlaces && onPlaces(q('[data-act="places"]')),
    settings: () => onSettings && onSettings(),
    help: () => onHelp && onHelp(),
    follow: () => onFollow && onFollow(),
    fly: () => onFly && onFly(),
    fun: () => onFun && onFun(),
    sound: () => onSound && onSound(),
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
    /** Show whether Follow tip is on. */
    setFollow(on) {
      if (!followBtn) return;
      followBtn.classList.toggle('on', !!on);
      followBtn.setAttribute('aria-pressed', String(!!on));
    },
    /** Show whether flight mode is on. */
    setFly(on) {
      if (!flyBtn) return;
      flyBtn.classList.toggle('on', !!on);
      flyBtn.setAttribute('aria-pressed', String(!!on));
    },
    /** Show whether sound is on. */
    setSound(on) {
      if (!soundBtn) return;
      soundBtn.classList.toggle('on', !!on);
      soundBtn.setAttribute('aria-pressed', String(!!on));
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
        speedCycle.textContent = speedLabel(state.speed);
        speedCycle.title = speedHint(speedById(state.speed)) + '; press for the next speed';
        speedCycle.setAttribute('aria-label', 'Playback speed ' + speedLabel(state.speed) + ', press for the next speed');
        shown.speed = state.speed;
      }
    },
  };
}
