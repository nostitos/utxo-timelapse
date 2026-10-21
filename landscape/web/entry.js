// Decide the first-visit destination before importing the renderer or loading the dataset.
import { entryDestination, hasExplorerCookie, explorerCookie, SETTINGS_KEY } from './ui/entry.js';

let remembered = false;
try { remembered = hasExplorerCookie(document.cookie); } catch {}
// People who already used the landscape keep their existing entry behavior.
try { remembered ||= !!localStorage.getItem(SETTINGS_KEY); } catch {}

const destination = entryDestination(location, remembered);
if (destination) {
  location.replace(destination);
} else {
  // /explorer is always available even when cookies or browser storage are blocked.
  try { document.cookie = explorerCookie(location.protocol); } catch {}
  import('./main.js').catch(error => console.error('landscape entry', error));
}
