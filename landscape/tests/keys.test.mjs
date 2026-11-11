// ui/keys.js: which keys act, in which order Escape closes things, and when keys are left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKey, isTypingTarget } from '../web/ui/keys.js';
import { STEP_LARGE } from '../web/ui/playback.js';

globalThis.document ??= { body: {} };

function app(over = {}) {
  const log = [];
  const spy = (name) => (...a) => log.push([name, ...a]);
  const menu = (name, open = false) => ({ open, close: spy(name + '.close'), toggle: spy(name + '.toggle') });
  const parts = {
    playback: { toggle: spy('toggle'), step: spy('step'), setSpeed: spy('setSpeed') },
    controls: { mode: 'map', setMode: spy('setMode'), toggleFlight: spy('flight'), togglePlane: spy('plane'), inspectPoint: () => ({ x: 1, y: 2 }) },
    planeHud: { noseClient: () => ({ x: 5, y: 6 }) },
    follow: { active: false },
    help: menu('help'), share: { open: false }, inspector: { isOpen: false, close: spy('inspector.close') },
    funMenu: menu('fun'), placesMenu: menu('places'), ownersMenu: menu('owners'),
    touchOnly: false, notice: spy('notice'), inspectAt: spy('inspectAt'), cycleCraft: spy('craft'), startRun: spy('run'),
    setFollow: spy('follow'), toggleSound: spy('sound'), togglePanel: spy('panel'), panelOpen: () => false, toggleOwnersMenu: spy('owners'),
    ...over,
  };
  const press = (code, extra = {}) => {
    handleKey({ code, target: null, preventDefault: spy('preventDefault'), ...extra }, parts);
    return log.splice(0);
  };
  return { parts, press };
}

test('keys: playback, steps and speeds', () => {
  const { press } = app();
  assert.deepEqual(press('Space'), [['preventDefault'], ['toggle']]);
  assert.deepEqual(press('BracketRight', { shiftKey: true }), [['preventDefault'], ['step', STEP_LARGE]]);
  assert.deepEqual(press('BracketLeft'), [['preventDefault'], ['step', -1]]);
  assert.deepEqual(press('Digit3'), [['setSpeed', '5'], ['notice', 'Speed 5\u00d7', 'info', 'speed']]);
  assert.deepEqual(press('KeyN'), [['follow', true]]);
  assert.deepEqual(press('KeyI'), [['inspectAt', 1, 2]]);
});

test('keys: left alone with a modifier, in text fields, under the share dialog or the help', () => {
  const { parts, press } = app();
  assert.deepEqual(press('Space', { metaKey: true }), []);
  assert.deepEqual(press('Space', { defaultPrevented: true }), []);
  assert.deepEqual(press('Space', { target: { tagName: 'INPUT', type: 'text' } }), []);
  assert.deepEqual(press('Space', { target: { tagName: 'INPUT', type: 'range', closest: () => null } }), [['preventDefault'], ['toggle']]);
  assert.deepEqual(press('Space', { target: { tagName: 'SELECT', closest: (s) => s.includes('#panel select') } }), []);
  parts.share.open = true;
  assert.deepEqual(press('Space'), []);
  parts.share.open = false;
  parts.help.open = true;
  assert.deepEqual(press('Space'), [], 'the help lets only Escape, H and ? through');
  assert.deepEqual(press('KeyH'), [['fun.close'], ['help.toggle']]);
  assert.equal(isTypingTarget({ isContentEditable: true }), true);
  assert.equal(isTypingTarget(globalThis.document.body), false);
});

test('keys: Escape leaves the plane first, then closes one thing at a time', () => {
  const plane = app({ controls: { mode: 'plane', setMode: (...a) => plane.log.push(['setMode', ...a]) } });
  plane.log = [];
  plane.parts.help.open = true;
  plane.press('Escape');
  assert.deepEqual(plane.log, [['setMode', 'map']], 'the help stays open');
  const order = [['help', 'help.close'], ['funMenu', 'fun.close'], ['placesMenu', 'places.close'], ['ownersMenu', 'owners.close']];
  for (const [name, call] of order) {
    const { parts, press } = app();
    parts[name].open = true;
    parts.inspector.isOpen = true;
    assert.deepEqual(press('Escape'), [[call]], name + ' before the inspector');
  }
  const { parts, press } = app({ panelOpen: () => true });
  parts.inspector.isOpen = true;
  assert.deepEqual(press('Escape'), [['inspector.close']], 'the inspector before the settings panel');
  parts.inspector.isOpen = false;
  assert.deepEqual(press('Escape'), [['panel', false]]);
});

test('keys: the plane and Stack sats keys stay off on touch-only devices', () => {
  const { parts, press } = app({ controls: { mode: 'plane', setMode() {}, togglePlane() {} } });
  assert.deepEqual(press('Enter'), [['preventDefault'], ['run']]);
  assert.deepEqual(press('Enter', { target: { tagName: 'BUTTON', closest: (s) => s === 'a, button' } }), [], 'a focused button handles Enter');
  assert.deepEqual(press('KeyC'), [['craft']]);
  parts.touchOnly = true;
  assert.deepEqual(press('Enter'), []);
  assert.deepEqual(press('KeyC'), []);
  assert.deepEqual(press('KeyT'), []);
});
