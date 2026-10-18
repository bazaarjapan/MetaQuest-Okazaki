// Run on the isolated classroom at 1101/1280/1439/1440 CSS pixels.
(async () => {
  const state = () => window.__okazaki.getState();
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (!state().activityAllowed) throw Error('Authenticated fixture required');
  if (document.body.dataset.panelOpen === 'true') document.querySelector('#panel-close').click();
  if (!state().free) document.querySelector('#free-move').click();
  // Movement enablement is adopted on the next render frame.
  await wait(200);
  key('keydown', 'KeyZ'); await wait(500); key('keyup', 'KeyZ'); await wait(250);
  try {
    const hint = document.querySelector('#rocket-hint'), hud = document.querySelector('#current-location');
    const a = hud.getBoundingClientRect(), b = hint.getBoundingClientRect();
    const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    if (!state().creative.wingFlight || hint.hidden || hud.hidden) throw Error('Flight hints must be visible');
    if (overlap) throw Error(`Location/rocket hint overlap at ${innerWidth}px`);
    return { passed: true, width: innerWidth, flightHint: hint.textContent, hudBottom: a.bottom, hintTop: b.top };
  } finally { key('keydown', 'KeyX'); key('keyup', 'KeyX'); }
})();
