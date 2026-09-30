export const panelIds = Object.freeze(['observe', 'region', 'settings']);
export function nextPanel(id, offset) {
  const index = Math.max(0, panelIds.indexOf(id));
  return panelIds[(index + offset % panelIds.length + panelIds.length) % panelIds.length];
}

/** One compact desktop sidebar, or a dismissible mobile bottom sheet. */
export function createAdaptiveUi() {
  const media = matchMedia('(max-width: 800px), (max-width: 1000px) and (max-height: 500px)');
  const aside = document.querySelector('#control-panel');
  let active = 'observe', open = false, returnFocus = null;
  function render() {
    document.body.dataset.panelOpen = String(media.matches && open);
    aside.inert = media.matches && !open;
    aside.setAttribute('aria-hidden', String(media.matches && !open));
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
  function close() {
    open = false;
    if (media.matches && aside.contains(document.activeElement)) returnFocus?.focus();
    render();
  }
  function show(id) {
    if (!panelIds.includes(id)) return;
    active = id; open = true; render();
    if (media.matches) document.querySelector('#tab-' + id).focus({ preventScroll: true });
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
      document.querySelector('#tab-' + id).focus();
    });
  }
  for (const button of document.querySelectorAll('[data-mobile-panel]')) {
    button.addEventListener('click', () => {
      returnFocus = button;
      if (open && active === button.dataset.mobilePanel) close();
      else show(button.dataset.mobilePanel);
    });
  }
  document.querySelector('#panel-close').addEventListener('click', close);
  document.querySelector('#quality-shortcut').addEventListener('click', () => show('settings'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('#help-dialog').open) close();
  });
  document.querySelector('#viewport').addEventListener('pointerdown', close);
  media.addEventListener('change', () => {
    if (media.matches && aside.contains(document.activeElement)) {
      returnFocus = document.querySelector('[data-mobile-panel=' + active + ']');
      returnFocus.focus({ preventScroll: true });
    }
    open = false; render();
  });
  render();
  return { show, close, getState: () => ({ mobile: media.matches, active, open: media.matches && open }) };
}
