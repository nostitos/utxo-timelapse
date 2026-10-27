// Welcome for a first visit to the bare public domain (ui/entry.js decides): read about the site
// in the guide, or use the explorer, which keeps loading behind the dialog. The explorer button,
// Esc and a click outside the dialog close it; entry.js remembers the visit, so it shows once.

export function showWelcome(doc = document) {
  const dialog = doc.createElement('dialog');
  dialog.id = 'welcome';
  dialog.setAttribute('aria-labelledby', 'welcome-title');
  dialog.setAttribute('aria-describedby', 'welcome-lead');
  dialog.innerHTML =
    '<div class="welcome-card" tabindex="-1" autofocus><span class="eyebrow">Bitcoin Landscape</span>' +
    '<h2 id="welcome-title">Every unspent output, <em>in three dimensions.</em></h2>' +
    '<p id="welcome-lead">Bitcoin\u2019s unspent outputs as a landscape you can fly over, rebuilt from the real chain ' +
    'block by block in your browser. Play it, pause anywhere and click a spot to see the coins there.</p>' +
    '<div class="welcome-choices">' +
    '<a class="welcome-choice" href="/guide/"><strong>About this site</strong><span>The guide and a three-minute film</span></a>' +
    '<button type="button" class="welcome-choice primary" data-explore><strong>Use the explorer</strong>' +
    '<span>Go straight to the landscape</span></button></div></div>';
  doc.body.append(dialog);
  const win = doc.defaultView;
  // The app's keys (Space, WASD, H, G...) wait for the choice; Tab, Enter and Esc work in the dialog.
  const quiet = (e) => {
    if (dialog.open) e.stopPropagation();
  };
  win.addEventListener('keydown', quiet, true);
  dialog.addEventListener('close', () => win.removeEventListener('keydown', quiet, true), { once: true });
  dialog.querySelector('[data-explore]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close(); // the backdrop
  });
  dialog.showModal();
  return dialog;
}
