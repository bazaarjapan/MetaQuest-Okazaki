export function worldActivityAllowed(state, ready = true) {
  return Boolean(ready && state?.user && !state.user.namePending && state.world && state.connection === "connected");
}
// Install before input handlers. Inert surfaces protect keyboard/touch focus;
// capture protects window-level shortcuts, wheel and pointer-lock listeners.
export function createActivityGate({ documentTarget = document, windowTarget = window, onOpen, onLock = () => {}, onRetry = () => windowTarget.location.reload() }) {
  const gate = documentTarget.querySelector("#login-gate");
  const message = gate.querySelector("p"), button = gate.querySelector("button");
  const surfaces = [...documentTarget.querySelectorAll("body > header,body > main,body > nav,body > footer")];
  let allowed = false, loadError = null;
  const events = ["keydown","keyup","pointerdown","pointerup","pointermove","mousedown","mouseup","mousemove","click","dblclick","contextmenu","wheel","touchstart","touchmove","touchend"];
  function intercept(event) {
    if (allowed || event.target?.closest?.("#school-dialog,#login-gate") || (event.type === "keydown" && event.key === "Tab")) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  for (const type of events) windowTarget.addEventListener(type,intercept,{capture:true,passive:false});
  for (const surface of surfaces) surface.inert = true;
  const open = () => loadError ? onRetry() : onOpen();
  button.addEventListener("click",open);
  function update(state, ready = true) {
    const next = !loadError && worldActivityAllowed(state,ready), wasAllowed = allowed;
    allowed = next;
    gate.hidden = next;
    for (const surface of surfaces) if (surface.inert === next) surface.inert = !next;
    if (!next) {
      message.textContent = loadError ? `街を読み込めませんでした。${loadError}` : !state?.user ? "ログインすると、移動・視点操作・VR・作品づくりを始められます。生徒は先生から受け取ったID・パスワードを使ってください。" :
        state.user.namePending ? "最初にみんなに見える名前を決めてください。名前を保存してワールドに接続すると操作できます。" :
        !ready ? "街のデータを準備しています。接続が完了すると操作できます。" : "ワールドに接続中です。通信が戻るまで操作を停止しています。接続できない場合はアカウント画面で確認してください。";
      button.textContent = loadError ? "ページを再読み込み" : !state?.user ? "ログインして始める" : state.user.namePending ? "名前を決める" : "アカウント・接続を確認";
      if (wasAllowed) onLock();
    }
    return next;
  }
  return { update, isAllowed: () => allowed,
    setError(error) { loadError = error; update(null,false); },
    destroy() { for(const type of events)windowTarget.removeEventListener(type,intercept,{capture:true});button.removeEventListener("click",open); } };
}
