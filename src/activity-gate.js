export function worldActivityAllowed(state, ready = true) {
  return Boolean(ready && state?.user && !state.user.namePending && state.world && state.connection === "connected");
}
// Install before input handlers. Inert surfaces protect keyboard/touch focus;
// capture protects window-level shortcuts, wheel and pointer-lock listeners.
export function createActivityGate({ documentTarget = document, windowTarget = window, onOpen, onLock = () => {}, onRetry = () => windowTarget.location.reload() }) {
  const gate = documentTarget.querySelector("#login-gate");
  const message = gate.querySelector("p"), buttons = [...gate.querySelectorAll("button")], button = buttons[0];
  const entryContents = new Map(buttons.map(item => [item, item.innerHTML]));
  const surfaces = [...documentTarget.querySelectorAll("body > header,body > main,body > nav,body > footer")];
  let allowed = false, loadError = null;
  const events = ["keydown","keyup","pointerdown","pointerup","pointermove","mousedown","mouseup","mousemove","click","dblclick","contextmenu","wheel","touchstart","touchmove","touchend"];
  function intercept(event) {
    if (allowed || event.target?.closest?.("#school-dialog,#login-gate") || (event.type === "keydown" && event.key === "Tab")) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  for (const type of events) windowTarget.addEventListener(type,intercept,{capture:true,passive:false});
  for (const surface of surfaces) surface.inert = true;
  const open = new Map(buttons.map(item => [item, () => loadError ? onRetry() : onOpen(item.dataset?.loginRole)]));
  for (const [item, handler] of open) item.addEventListener("click", handler);
  function update(state, ready = true) {
    const next = !loadError && worldActivityAllowed(state,ready), wasAllowed = allowed;
    allowed = next;
    gate.hidden = next;
    for (const surface of surfaces) if (surface.inert === next) surface.inert = !next;
    if (!next) {
      message.textContent = loadError ? `街を読み込めませんでした。${loadError}` : !state?.user ? "どちらの入り口から入りますか？" :
        state.user.namePending ? "最初にみんなに見える名前を決めてください。名前を保存してワールドに接続すると操作できます。" :
        !ready ? "街のデータを準備しています。接続が完了すると操作できます。" : "ワールドに接続中です。通信が戻るまで操作を停止しています。接続できない場合はアカウント画面で確認してください。";
      if (!loadError && !state?.user && entryContents.get(button) !== undefined) {
        for (const item of buttons) if (item.innerHTML !== entryContents.get(item)) item.innerHTML = entryContents.get(item);
      } else button.textContent = loadError ? "ページを再読み込み" : !state?.user ? "ログイン" : state.user.namePending ? "名前を決める" : "アカウント・接続を確認";
      for (const item of buttons.slice(1)) item.hidden = Boolean(loadError || state?.user);
      if (wasAllowed) onLock();
    }
    return next;
  }
  return { update, isAllowed: () => allowed,
    setError(error) { loadError = error; update(null,false); },
    destroy() { for(const type of events)windowTarget.removeEventListener(type,intercept,{capture:true});for(const [item,handler] of open)item.removeEventListener("click",handler); } };
}
