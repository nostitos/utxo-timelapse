// What remains: progressive enhancement for the guide. Everything reads without this file.
// Previews: lazy poster and source, at most one plays, only when mostly in view, never with reduced
// motion or Save-Data unless the viewer presses its Motion button. The film opens in a dialog with
// sound only when the viewer asks. Reveal motion and movement highlighting. No scroll interception.

const root = document.documentElement;
root.classList.add('js');

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const saveData = !!(navigator.connection && navigator.connection.saveData === true);
const autoplayAllowed = () => !reduceMotion.matches && !saveData;

let pageLoaded = document.readyState === 'complete';
const MOSTLY = 0.6; // share of the preview (or of the viewport, for tall ones) that counts as "in view"
const AWAY = 0.2;   // below this the playing preview pauses

// ---------------------------------------------------------------------------------------------
// Previews

const previews = [...document.querySelectorAll('[data-preview]')].map((el) => ({
  el,
  video: el.querySelector('video'),
  button: el.querySelector('.motion'),
  afterLoad: el.hasAttribute('data-after-load'),
  visible: 0,
  userPaused: false,
  userStarted: false,
  completed: false,
})).filter((p) => p.video && p.video.dataset.src);

let current = null;
let blocked = false; // the film dialog is open

function attachPoster(p) {
  const v = p.video;
  if (!v.getAttribute('poster') && v.dataset.lazyPoster) v.setAttribute('poster', v.dataset.lazyPoster);
}

function setPressed(p, on) {
  if (p.button) p.button.setAttribute('aria-pressed', on ? 'true' : 'false');
  p.el.classList.toggle('is-playing', on);
}

function play(p) {
  // A finished, non-looping preview stays on its last frame until an explicit replay.
  if (p.completed) return;
  if (current && current !== p) stop(current);
  current = p;
  const v = p.video;
  attachPoster(p);
  if (!v.getAttribute('src')) {
    v.src = v.dataset.src;
  }
  v.muted = true;
  setPressed(p, true);
  const result = v.play();
  if (result && typeof result.catch === 'function') {
    result.catch(() => {
      if (current === p) current = null;
      setPressed(p, false);
    });
  }
}

function stop(p) {
  p.video.pause();
  setPressed(p, false);
  if (current === p) current = null;
}

function choose() {
  if (document.hidden || blocked) {
    if (current) current.video.pause();
    return;
  }
  // Keep a preview the viewer started while it stays on screen; pause anything that has left.
  if (current && current.visible < AWAY) {
    const p = current;
    stop(p);
    p.userStarted = false;
  }
  if (current) {
    if (current.userStarted || current.visible >= MOSTLY) {
      if (current.video.paused) play(current);
      return;
    }
  }
  if (!autoplayAllowed()) return;
  let best = null;
  for (const p of previews) {
    if (p.completed || p.userPaused || p.visible < MOSTLY) continue;
    if (p.afterLoad && !pageLoaded) continue;
    if (!best || p.visible > best.visible) best = p;
  }
  if (best && best !== current) play(best);
}

if (previews.length) {
  for (const p of previews) {
    p.video.addEventListener('playing', () => p.el.classList.add('is-live'));
    p.video.addEventListener('ended', () => {
      p.completed = true;
      p.userStarted = false;
      stop(p);
      const label = p.button?.querySelector('.motion-label');
      if (label) label.textContent = 'Replay';
      // Keep is-live: the video continues to display its final frame above the poster.
    });
    p.video.addEventListener('error', () => {
      p.el.classList.remove('is-live');
      setPressed(p, false);
      if (current === p) current = null;
    });
    if (p.button) {
      p.button.hidden = false;
      p.button.addEventListener('click', () => {
        if (current === p && !p.video.paused) {
          p.userPaused = true;
          p.userStarted = false;
          stop(p);
        } else {
          if (p.completed) {
            p.completed = false;
            p.video.currentTime = 0;
            const label = p.button.querySelector('.motion-label');
            if (label) label.textContent = 'Motion';
          }
          p.userPaused = false;
          p.userStarted = true;
          if (current && current !== p) current.userStarted = false;
          play(p);
        }
      });
    }
  }

  if ('IntersectionObserver' in window) {
    // Posters arrive a screen ahead; playback decisions use the visible share.
    const near = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const p = previews.find((q) => q.el === e.target);
          if (p) attachPoster(p);
          near.unobserve(e.target);
        }
      }
    }, { rootMargin: '100% 0px' });

    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = previews.find((q) => q.el === e.target);
        if (!p) continue;
        const vh = e.rootBounds ? e.rootBounds.height : innerHeight;
        p.visible = e.isIntersecting ? Math.max(e.intersectionRatio, e.intersectionRect.height / vh) : 0;
      }
      choose();
    }, { threshold: [0, 0.1, 0.2, 0.4, 0.6, 0.8, 1] });

    for (const p of previews) {
      near.observe(p.el);
      seen.observe(p.el);
    }
  }

  document.addEventListener('visibilitychange', choose);
  reduceMotion.addEventListener?.('change', () => {
    if (!autoplayAllowed() && current && !current.userStarted) stop(current);
    choose();
  });
}

if (!pageLoaded) {
  addEventListener('load', () => {
    pageLoaded = true;
    choose();
  }, { once: true });
}

// ---------------------------------------------------------------------------------------------
// The film opens from the opening button in a dialog and starts with sound, since the visitor
// asked for it. Closing pauses it and returns focus; previews stay paused while it is open.

const dialog = document.getElementById('film');
if (dialog && typeof dialog.showModal === 'function') {
  const film = dialog.querySelector('video');
  const closeButton = dialog.querySelector('[data-film-close]');
  let opener = null;

  for (const a of document.querySelectorAll('[data-film-open]')) {
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      opener = a;
      blocked = true;
      choose();
      if (!film.getAttribute('poster') && film.dataset.lazyPoster) film.setAttribute('poster', film.dataset.lazyPoster);
      if (!film.getAttribute('src')) film.src = film.dataset.src;
      dialog.showModal();
      closeButton.focus();
      film.muted = false;
      const result = film.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    });
  }

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    film.pause();
    blocked = false;
    if (opener) opener.focus();
    opener = null;
    choose();
  });
}

// The key reference starts closed where there are no keys to press.
const keyref = document.querySelector('[data-keyref]');
if (keyref && matchMedia('(hover: none)').matches) keyref.open = false;

// ---------------------------------------------------------------------------------------------
// Chapter highlighting in the movement index (normal anchors; nothing intercepts scrolling).

const indexLinks = new Map(
  [...document.querySelectorAll('.index a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]),
);
if (indexLinks.size && 'IntersectionObserver' in window) {
  const sections = [...indexLinks.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  const active = new Set();
  const mark = () => {
    let id = null;
    for (const s of sections) if (active.has(s.id)) { id = s.id; break; }
    for (const [key, a] of indexLinks) {
      if (key === id) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    }
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) active.add(e.target.id);
      else active.delete(e.target.id);
    }
    mark();
  }, { rootMargin: '-40% 0px -55% 0px' });
  for (const s of sections) io.observe(s);
}

// ---------------------------------------------------------------------------------------------
// Reveal: a slow fade and rise for content below the first screen; none with reduced motion.

if (!reduceMotion.matches && 'IntersectionObserver' in window) {
  const items = [...document.querySelectorAll('.reveal')].filter((el) => el.getBoundingClientRect().top > innerHeight * 0.92);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.remove('is-pending');
        io.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of items) {
    el.classList.add('is-pending');
    io.observe(el);
  }
}
