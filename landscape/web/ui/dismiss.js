// Close button for an overlay box (the legend and the overview). Dismissing hides the box for
// this page load only: nothing is saved, so a reload brings it back. The Overlays settings
// (display.legend, display.minimap) remain the way to turn a box off for good.

/** A small × button that calls onDismiss; label names the box for screen readers. */
export function dismissButton(label, onDismiss) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'box-close';
  button.title = 'Hide until reload';
  button.setAttribute('aria-label', 'Hide ' + label + ' until reload');
  button.textContent = '\u00d7';
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (onDismiss) onDismiss();
  });
  return button;
}
