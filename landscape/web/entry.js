// Shows the first-visit welcome, then loads the app; the renderer and dataset load behind it.
import { showsWelcome, hasExplorerCookie, explorerCookie, SETTINGS_KEY } from './ui/entry.js';
import { showWelcome } from './ui/welcome.js';

let remembered = false;
try { remembered = hasExplorerCookie(document.cookie); } catch {}
// People who already used the landscape keep their existing entry behavior.
try { remembered ||= !!localStorage.getItem(SETTINGS_KEY); } catch {}

if (showsWelcome(location, remembered)) {
  try { showWelcome(document); } catch (error) { console.error('landscape welcome', error); }
}
// Remember the visit for a year, so the welcome shows once.
try { document.cookie = explorerCookie(location.protocol); } catch {}
import('./main.js').catch(error => console.error('landscape entry', error));
