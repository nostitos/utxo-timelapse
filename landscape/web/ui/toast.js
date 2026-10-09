// Transient notices at the bottom centre. show(message, kind, key): a repeated key
// replaces the visible notice instead of stacking (e.g. flight speed while scrolling).

export function createToast(container) {
  const live = new Map();
  function show(message, kind = 'info', key = null, ms = kind === 'error' ? 7000 : 2600) {
    let item = key ? live.get(key) : null;
    if (!item) {
      const el = document.createElement('div');
      el.className = 'toast-item';
      container.appendChild(el);
      item = { el, timer: 0 };
      if (key) live.set(key, item);
    }
    item.el.dataset.kind = kind;
    item.el.textContent = message;
    item.el.classList.remove('leaving');
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      item.el.classList.add('leaving');
      setTimeout(() => {
        item.el.remove();
        if (key && live.get(key) === item) live.delete(key);
      }, 260);
    }, ms);
    return item.el;
  }
  return { show };
}
