// The app's keyboard shortcuts (ui/help.js lists them). main.js passes the parts of the app they
// act on to handleKey(e, app).
import { speedById, SPEED_KEYS, STEP_LARGE } from './playback.js';

/** True when keys typed into el belong to it (text fields), not to the app's shortcuts. */
export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file'].includes(type);
  }
  return !!el.isContentEditable;
}

/**
 * One keydown. app: {playback, controls, planeHud, follow, help, share, inspector, funMenu,
 * placesMenu, ownersMenu, touchOnly, notice, inspectAt, cycleCraft, startRun, setFollow,
 * toggleSound, togglePanel, panelOpen, toggleOwnersMenu}.
 */
export function handleKey(e, app) {
  const { playback, controls, planeHud, follow, help, share, inspector, funMenu, placesMenu, ownersMenu, touchOnly, notice,
    inspectAt, cycleCraft, startRun, setFollow, toggleSound, togglePanel, panelOpen, toggleOwnersMenu } = app;
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || share.open) return;
  if (isTypingTarget(e.target) || (e.target && e.target.closest && e.target.closest('#panel input, #panel select, #panel textarea'))) return;
  if (help.open && !['Escape', 'KeyH', 'Slash'].includes(e.code)) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      playback.toggle();
      break;
    case 'BracketLeft':
      e.preventDefault();
      playback.step(e.shiftKey ? -STEP_LARGE : -1);
      break;
    case 'BracketRight':
      e.preventDefault();
      playback.step(e.shiftKey ? STEP_LARGE : 1);
      break;
    case 'Digit0':
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4': {
      const s = speedById(SPEED_KEYS[e.code]);
      playback.setSpeed(s.id);
      notice('Speed ' + s.label, 'info', 'speed');
      break;
    }
    case 'KeyI': {
      // In plane mode, inspect where the nose points (its circle), else as the controls say.
      const p = (controls.mode === 'plane' && planeHud.noseClient()) || controls.inspectPoint();
      if (p) inspectAt(p.x, p.y);
      break;
    }
    case 'KeyF':
      controls.toggleFlight();
      break;
    case 'KeyT':
      if (!touchOnly) {
        funMenu.close();
        controls.togglePlane();
      }
      break;
    case 'KeyC':
      if (!touchOnly) cycleCraft();
      break;
    case 'Enter':
    case 'NumpadEnter':
      // A focused button (the end card's Again, a menu item) or link handles Enter itself.
      if (e.target && e.target.closest && e.target.closest('a, button')) break;
      if (!touchOnly && controls.mode === 'plane') {
        e.preventDefault();
        startRun();
      }
      break;
    case 'KeyN':
      setFollow(!follow.active);
      break;
    case 'KeyM':
      toggleSound();
      break;
    case 'KeyG':
      // Panels need the cursor: leave plane mode (and its pointer lock) first.
      if (controls.mode === 'plane') controls.setMode('map');
      funMenu.close();
      togglePanel();
      break;
    case 'KeyP':
      if (controls.mode === 'plane') controls.setMode('map');
      funMenu.close();
      ownersMenu.close();
      placesMenu.toggle();
      break;
    case 'KeyO':
      toggleOwnersMenu();
      break;
    case 'KeyH':
      if (controls.mode === 'plane') controls.setMode('map');
      funMenu.close();
      help.toggle();
      break;
    case 'Slash':
      if (e.shiftKey) {
        if (controls.mode === 'plane') controls.setMode('map');
        funMenu.close();
        help.toggle();
      }
      break;
    case 'Escape':
      if (controls.mode !== 'map') controls.setMode('map');
      else if (help.open) help.close();
      else if (funMenu.open) funMenu.close();
      else if (placesMenu.open) placesMenu.close();
      else if (ownersMenu.open) ownersMenu.close();
      else if (inspector.isOpen) inspector.close();
      else if (panelOpen()) togglePanel(false);
      break;
    default:
  }
}
