const GOOGLE_IDENTITY_URL = "https://accounts.google.com/gsi/client";

// A failed/stalled script must not trap every later retry behind a load event
// that will never fire. This helper owns only the exact official GIS script.
export function createGoogleIdentityLoader({ documentImpl = globalThis.document, globalObject = globalThis,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
  let pending = null;
  return function loadGoogleIdentity() {
    if (globalObject.google?.accounts?.id) return Promise.resolve(globalObject.google.accounts.id);
    if (pending) return pending;
    let resolveTask, rejectTask;
    const task = new Promise((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    pending = task;
    let script = documentImpl.querySelector(`script[src="${GOOGLE_IDENTITY_URL}"]`);
    const fresh = !script;
    if (!script) { script = documentImpl.createElement("script"); script.src = GOOGLE_IDENTITY_URL; script.async = true; script.defer = true; }
    let completed = false;
    function cleanup() {
      clearTimeoutImpl(timer); script.removeEventListener("load", loaded); script.removeEventListener("error", failed);
    }
    function failed() {
      if (completed) return; completed = true; cleanup(); script.remove(); pending = null; rejectTask(new Error("gis_unavailable"));
    }
    function loaded() {
      if (completed) return;
      const api = globalObject.google?.accounts?.id;
      if (!api) { failed(); return; }
      completed = true; cleanup(); resolveTask(api);
    }
    const timer = setTimeoutImpl(failed, 15000);
    script.addEventListener("load", loaded); script.addEventListener("error", failed);
    if (fresh) documentImpl.head.append(script);
    return task;
  };
}
