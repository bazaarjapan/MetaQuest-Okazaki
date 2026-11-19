export const panelIds = Object.freeze(['observe', 'region', 'settings']);
export function nextPanel(id, offset) {
  const index = Math.max(0, panelIds.indexOf(id));
  return panelIds[(index + offset % panelIds.length + panelIds.length) % panelIds.length];
}

/** A wide menu that only scrolls when its content exceeds the viewport. */
export function createAdaptiveUi({ isEscapeReserved = () => false } = {}) {
  const media = matchMedia('(max-width: 800px), (max-width: 1000px) and (max-height: 500px), (pointer: coarse)');
  const aside = document.querySelector('#control-panel');
  const body = aside.querySelector('.panel-body');
  let active = 'observe', open = false, returnFocus = null;

  function defaultOpener() {
    return document.querySelector(media.matches ? '[data-mobile-panel=' + active + ']' : '#simple-menu');
  }
  function render() {
    document.body.dataset.panelOpen = String(open);
    aside.inert = !open;
    document.querySelector('#simple-menu')?.setAttribute('aria-expanded', String(open));
    aside.setAttribute('aria-hidden', String(!open));
    // Keep the compact mobile sheet for its selected task. VR setup belongs
    // with settings there; desktop keeps the always-visible action footer.
    const vrParent = document.querySelector(media.matches ? '#panel-settings' : '.panel-footer');
    for (const id of ['enter-vr', 'vr-note']) {
      const element = document.getElementById(id);
      if (element.parentElement !== vrParent) vrParent.append(element);
    }
    for (const id of panelIds) {
      document.querySelector('#panel-' + id).hidden = active !== id;
      const tab = document.querySelector('#tab-' + id);
      tab.setAttribute('aria-selected', String(active === id));
      tab.tabIndex = active === id ? 0 : -1;
      const mobile = document.querySelector('[data-mobile-panel=' + id + ']');
      mobile.setAttribute('aria-expanded', String(media.matches && open && active === id));
      mobile.classList.toggle('active', media.matches && open && active === id);
    }
  }
  function close({ restoreFocus = true } = {}) {
    if (!open) return;
    open = false;
    if (restoreFocus && !document.querySelector('dialog[open]') &&
        (aside.contains(document.activeElement) || document.activeElement === document.body)) {
      const target = returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus : defaultOpener();
      target?.focus({ preventScroll: true });
    }
    returnFocus = null;
    render();
  }
  function show(id, opener = document.activeElement) {
    if (!panelIds.includes(id) || document.querySelector('dialog[open], #login-gate:not([hidden])')) return;
    if (!open) returnFocus = opener && opener !== document.body && !aside.contains(opener) ? opener : defaultOpener();
    const resetScroll = !open || active !== id;
    active = id; open = true; render();
    if (resetScroll) body.scrollTop = 0;
    document.querySelector('#tab-' + id).focus({ preventScroll: true });
  }
  for (const button of document.querySelectorAll('[data-panel-target]')) {
    button.addEventListener('click', () => show(button.dataset.panelTarget));
    button.addEventListener('keydown', event => {
      let id;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) id = nextPanel(active, 1);
      else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) id = nextPanel(active, -1);
      else if (event.key === 'Home') id = 'observe';
      else if (event.key === 'End') id = 'settings';
      if (!id) return;
      event.preventDefault(); event.stopPropagation(); show(id);
    });
  }
  for (const button of document.querySelectorAll('[data-mobile-panel]')) {
    button.addEventListener('click', () => {
      if (open && active === button.dataset.mobilePanel) close();
      else {
        show(button.dataset.mobilePanel, button);
        if (open) returnFocus = button;
      }
    });
  }
  document.querySelector('#panel-close').addEventListener('click', close);
  document.querySelector('#quality-shortcut').addEventListener('click', () => {
    show('settings');
    if (!open || active !== 'settings') return;
    body.scrollTop = 0;
    const quality = document.querySelector('#quality-select');
    if (!quality.disabled) quality.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.repeat && !event.defaultPrevented &&
        !document.querySelector('dialog[open], #login-gate:not([hidden])') && !isEscapeReserved()) {
      if (open) close(); else show(active);
    }
  });
  document.querySelector('#viewport').addEventListener('pointerdown', () => close({ restoreFocus: false }));
  media.addEventListener('change', () => {
    if (open) {
      returnFocus = defaultOpener();
      close();
    } else render();
  });
  render();
  return { show, close, getState: () => ({ mobile: media.matches, active, open }) };
}
