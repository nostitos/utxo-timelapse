// UI checks use an isolated clipboard stub; no post, email or native share is sent.
async function checkLandscapeSharing(L) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const checks = [], check = (name, ok) => checks.push([name, !!ok]);
  const block = Math.min(971044, L.manifest.tip);
  const col = Math.min(13113, Math.floor(block / 64));
  const row = 1442, x = (col + .5) * .064, z = (row + .5) * .1;
  await L.seek(block);
  L.follow.set(false);
  L.controls.setPose({x:x,y:150,z,yaw:0,pitch:-89});
  await sleep(700);
  await L.ui.inspector.open({l0Col:col,l0Row:row,level:5,x,z});
  const toolbar = document.querySelector('[data-act="share"]');
  check('share control is visible in the main toolbar', toolbar && toolbar.getBoundingClientRect().width > 0);
  const r = toolbar.getBoundingClientRect();
  check('share control fits the viewport', r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight);
  const button = document.querySelector('[data-share-cell]');
  button.focus(); button.click();
  const d = document.getElementById('share');
  const q = s => d.querySelector(s), field = q('textarea');
  const selected = q('[value="cell"]'), view = q('[value="view"]'), play = q('[role="switch"]');
  const cellUrl = field.value;
  check('inspector share defaults to selected cell', d.open && selected.checked && new URL(cellUrl).hash.includes('cell=' + col + ',' + row));
  check('cell sharing disables autoplay', play.disabled && !play.checked && !new URL(cellUrl).hash.includes('play=1'));
  view.checked = true; view.dispatchEvent(new Event('change'));
  const viewUrl = field.value;
  check('current-view link excludes the active cell', !new URL(viewUrl).hash.includes('cell='));
  play.checked = true; play.dispatchEvent(new Event('change'));
  const autoplayUrl = field.value;
  check('autoplay can be enabled for a view link', new URL(autoplayUrl).hash.includes('play=1'));
  selected.checked = true; selected.dispatchEvent(new Event('change'));
  check('switching to a cell removes autoplay again', play.disabled && !play.checked && !new URL(field.value).hash.includes('play=1'));
  const expected = field.value;
  let copied = null;
  const ownClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async value=>{copied=value;}} });
    q('[data-copy]').click(); await sleep(20);
    check('copy button confirms the exact URL only after success', copied === expected && q('[data-copy]').textContent === 'Copied');
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async ()=>{throw new Error('Denied');}} });
    q('[data-copy]').click(); await sleep(20);
    check('clipboard denial selects a manual-copy fallback', document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === field.value.length && q('[role="status"]').textContent.includes('unavailable') && q('[data-copy]').textContent === 'Copy link');
  } finally {
    if (ownClipboard) Object.defineProperty(navigator,'clipboard',ownClipboard); else delete navigator.clipboard;
  }
  check('X and email links contain the same share URL', new URL(q('[data-x]').href).searchParams.get('url') === expected && q('[data-email]').href.includes(encodeURIComponent(expected)));
  const bounds = d.getBoundingClientRect();
  check('share dialog fits desktop or phone', bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight && d.scrollWidth <= d.clientWidth);
  const pose = L.controls.getPose();
  const previousBlock = L.replay.block;
  q('[value="cell"]').dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true}));
  await sleep(50);
  check('share dialog does not trigger global playback shortcuts', !L.playback.state.playing && L.replay.block === previousBlock);
  L.ui.share.close(); await sleep(20);
  check('closing share restores the triggering control focus', document.activeElement?.matches('[data-share-cell]'));
  L.ui.inspector.close();
  check('closing the inspector immediately clears the cell from the address bar', !location.hash.includes('cell='));
  toolbar.focus(); toolbar.click();
  check('closed inspector is never shared as a stale selection', selected.disabled && view.checked && !field.value.includes('cell='));
  L.ui.share.close();
  // Same-page hash navigation also restores and clears the selected cell.
  location.hash = new URL(cellUrl).hash;
  await sleep(100);
  for (let i=0;i<200 && !L.linkReady;i++) await sleep(50);
  check('cell hash navigation restores the inspector', L.linkReady && L.ui.inspector.selection?.col === col && L.ui.inspector.selection?.row === row && !L.playback.state.playing);
  location.hash = new URL(viewUrl).hash;
  await sleep(100);
  for (let i=0;i<200 && !L.linkReady;i++) await sleep(50);
  check('view hash navigation clears the inspector', L.linkReady && !L.ui.inspector.isOpen);
  await L.ui.inspector.open({l0Col:col,l0Row:row,level:5,x,z});
  document.querySelector('[data-share-cell]').click();
  return {checks,cellUrl,viewUrl,autoplayUrl,pose};
}
