import { parseSchoolInvite, schoolInviteURL } from "./school-client.js";
import { createGoogleIdentityLoader } from "./google-identity.js";
import "./school.css";

const ERROR_TEXT = {
  school_not_configured: "共同教室は準備中です。ログインなしの街・VR閲覧は引き続き使えます。",
  school_unavailable: "共同教室に接続できません。街の閲覧はそのまま使えます。",
  login_required: "Googleログインが必要です。",
  invalid_join_code: "先生から受け取った12文字の参加コード、または招待URLを入力してください。",
  join_code_not_found: "参加コードが見つかりません。先生に確認してください。",
  class_full: "この教室は30人の生徒で満員です。先生に確認してください。",
  room_full: "同時参加人数の上限に達しました。しばらくしてからもう一度開いてください。",
  other_teacher_world: "先生は自分が作成した教室のみ開けます。",
  teacher_required: "この操作はワールドを作成した先生だけができます。",
  stale_revision: "ほかの人の変更が先に保存されました。最新状態に更新したので、内容を確認してもう一度操作してください。",
  session_expired: "ログイン期限が切れました。もう一度Googleでログインしてください。",
  room_login_required: "ログインまたは教室への参加が必要です。",
  connected_elsewhere: "同じアカウントで別のタブ・端末が参加しました。こちらでは活動を停止しました。",
  connection_lost: "通信が切れました。接続が戻るまで作品の操作はできません。",
  connection_closed: "教室との接続が閉じられました。「続きを開く」で再接続できます。",
  request_timeout: "応答を確認できませんでした。保存状態を確認してから再操作してください。",
  edit_timeout: "配置の応答を確認できません。最新状態を読み直してから確認してください。",
  restore_recovery_pending: "ワールドの復元を安全に確認しています。少し待って再接続してください。",
  login_rate_limit: "ログインの試行が多いため、1分ほど待ってからやり直してください。",
  gis_unavailable: "Googleログインを読み込めませんでした。通信・ブラウザの制限を確認し、もう一度お試しください。",
  invalid_csrf: "ログインの準備が更新されました。もう一度Googleログインを表示してください。",
  already_logged_in: "このブラウザではログイン済みです。教室を選んで参加してください。",
  google_keys_unavailable: "Googleの本人確認に必要な公開鍵を取得できませんでした。1分ほど待ってから、もう一度Googleログインを表示してください。",
  invalid_token: "Googleのログイン情報を確認できませんでした。もう一度Googleログインを表示し、アカウントを選び直してください。",
  login_challenge_required: "ログインの準備情報が見つかりません。もう一度Googleログインを表示してください。続く場合は、このサイトのCookieが許可されているか確認してください。",
  login_challenge_expired: "ログインの準備が期限切れ、または使用済みです。もう一度Googleログインを表示してからログインしてください。",
  invalid_origin: "ログインするページのURLを確認できませんでした。https://metaquest001.gigach.net/ を開き直してお試しください。",
  login_cancelled: "ログイン中にアカウントの状態が変わりました。現在の状態を確認し、必要ならもう一度Googleログインを表示してください。",
  login_failed: "Googleログインの通信を完了できませんでした。通信を確認してから、もう一度Googleログインを表示してください。",
};
export function explainSchoolError(error) {
  const code = error?.code ?? error?.message ?? error;
  return ERROR_TEXT[code] ?? "共同教室の操作を完了できませんでした。状態を確認してもう一度お試しください。";
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function inputField(labelText, { type = "text", value = "", maxLength, id } = {}) {
  const label = element("label", undefined, "school-field");
  const input = element("input"); input.type = type; input.value = value;
  if (maxLength) input.maxLength = maxLength;
  if (id) input.id = id;
  label.append(element("span", labelText), input); return { label, input };
}
function actionButton(text, handler, id) {
  const button = element("button", text); button.type = "button";
  if (id) button.id = id;
  button.addEventListener("click", handler); return button;
}
const loadGoogleIdentity = createGoogleIdentityLoader();

export function createSchoolUI({ client, button, onBeforeOpen = () => {} }) {
  const dialog = element("dialog", undefined, "school-dialog"); dialog.id = "school-dialog";
  dialog.setAttribute("aria-labelledby", "school-title");
  const heading = element("div", undefined, "school-heading");
  const title = element("h2", "共同教室", "school-title"); title.id = "school-title";
  const closeButton = actionButton("閉じる", () => dialog.close(), "school-close"); heading.append(title, closeButton);
  const description = element("p", "街・VRの閲覧はログイン不要です。作品の配置・共同活動にはGoogleログインと教室への参加が必要です。", "school-note");
  const status = element("p", "接続確認中…", "school-status"); status.id = "school-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const content = element("div", undefined, "school-content");
  const privacy = element("a", "ログイン・作品保存について（プライバシー）"); privacy.href = "/privacy.html";
  dialog.append(heading, description, status, content, privacy); document.body.append(dialog);
  const summary = document.querySelector("#school-summary");
  let state = client.getState(), renderKey = "", busy = false, googleGeneration = 0;
  let googleHost = null, participantLabel = null, roomConnection = null;
  const inviteCode = parseSchoolInvite(globalThis.location?.href ?? "");
  function setStatus(text, error = false) { status.textContent = text; status.classList.toggle("is-error", error); }
  async function perform(task, message) {
    if (busy) return;
    busy = true; refreshDisabled(); setStatus("処理中…");
    try { await task(); if (message) setStatus(message); }
    catch (error) { setStatus(explainSchoolError(error), true); }
    finally { busy = false; refreshDisabled(); }
  }
  function refreshDisabled() {
    for (const item of dialog.querySelectorAll("button[data-school-action]")) item.disabled = busy || item.dataset.unavailable === "true";
  }
  function command(text, handler, id, unavailable = false) {
    const node = actionButton(text, handler, id); node.dataset.schoolAction = "true"; node.dataset.unavailable = String(unavailable); return node;
  }
  async function showGoogleButton() {
    const generation = ++googleGeneration;
    await perform(async () => {
      const [login, googleId] = await Promise.all([client.prepareGoogleLogin(), loadGoogleIdentity()]);
      if (generation !== googleGeneration || !dialog.open || client.getState().user) return;
      const host = googleHost;
      if (!host?.isConnected) return;
      host.replaceChildren();
      googleId.initialize({ client_id: login.clientId, nonce: login.nonce, auto_select: false, ux_mode: "popup",
        callback: async (response) => {
          if (generation !== googleGeneration || !dialog.open || !response?.credential) return;
          // No One Tap, no access/refresh token storage, no external account
          // revocation: this GCP consent application is shared with another app.
          await perform(() => client.login(response.credential), "ログインしました。先生の参加コードで教室を開いてください。");
          if (!client.getState().user && generation === googleGeneration) {
            host.replaceChildren(element("p", "ログインを表示し直してから再試行してください。", "school-note"));
          }
        } });
      googleId.renderButton(host, { type: "standard", theme: "outline", size: "large", text: "signin_with", shape: "rectangular", width: Math.max(220, Math.min(320, dialog.clientWidth - 50)), locale: "ja" });
      setStatus("Googleのボタンでログインしてください。");
    });
  }
  function renderGuest() {
    const section = element("section", undefined, "school-section");
    section.append(element("h3", "1. Googleでログイン"), element("p", "学校のGoogleアカウント、またはGmailを使います。同じアカウントで次回も同じアバターと作品を開けます。", "school-note"));
    section.append(element("p", "Googleの確認画面では、既存プロジェクトの共通アプリ名「教職員異動検索」が表示される場合があります。このアプリでは基本的な本人確認だけを行います。", "school-note"));
    const googleButton = command("Googleログインを表示", showGoogleButton, "school-login", !state.configured);
    googleHost = element("div", undefined, "school-google"); googleHost.id = "school-google";
    const retryButton = command("共同教室に再接続・設定を再確認", () => perform(async () => {
      const next = await client.init({ recheck: true });
      if (!next.configured || next.error) throw new Error(next.error ?? "school_not_configured");
    }, "共同教室の接続を確認しました。"), "school-retry");
    // This remains reachable even when initial config/session failed. It only
    // retries our own API; Google scripts stay lazy until the login button click.
    section.append(googleButton, retryButton, googleHost);
    if (inviteCode) section.append(element("p", `招待コード ${inviteCode} を受け取りました。ログイン後、「この教室に参加」を押してください。`, "school-note"));
    content.append(section);
  }
  function renderAccount() {
    const section = element("section", undefined, "school-section");
    section.append(element("h3", state.user.role === "teacher" ? "先生としてログイン中" : "生徒としてログイン中"));
    const row = element("div", undefined, "school-row");
    const name = inputField("アバターの名前（20文字まで）", { value: state.user.name, maxLength: 20, id: "school-avatar-name" });
    const color = inputField("色", { type: "color", value: state.user.color, id: "school-avatar-color" });
    row.append(name.label, color.label); section.append(row);
    const actions = element("div", undefined, "school-actions");
    actions.append(command("アバターを保存", () => perform(() => client.updateAvatar({ name: name.input.value, color: color.input.value }), "アバターを保存しました。"), "school-avatar-save"),
      command("ログアウト", () => perform(() => client.logout(), "ログアウトしました。街・VRの閲覧は続けられます。"), "school-logout"));
    section.append(actions); content.append(section);
  }
  function renderEntry() {
    const section = element("section", undefined, "school-section"); section.append(element("h3", "教室に参加"));
    const code = inputField("先生の参加コード・招待URL", { value: inviteCode ?? "", maxLength: 300, id: "school-join-code" });
    code.input.autocomplete = "off"; code.input.spellcheck = false;
    section.append(code.label, command("この教室に参加", () => perform(() => client.joinWorld(parseSchoolInvite(code.input.value) ?? code.input.value), "教室を開きました。接続完了後に共同活動できます。"), "school-join"));
    section.append(element("p", "先生がURLまたは12文字のコードを配ります。招待URLだけでは参加せず、ログイン後に自分で参加ボタンを押します。", "school-note"));
    if (state.worlds.length) {
      const label = element("label", undefined, "school-field"); label.append(element("span", "以前に参加した教室"));
      const select = element("select"); select.id = "school-world-list";
      for (const world of state.worlds) { const item = element("option", world.name); item.value = world.id; select.append(item); }
      if (state.world) select.value = state.world.id;
      label.append(select); section.append(label, command("続きを開く", () => perform(() => client.openWorld(select.value), "教室を開きました。"), "school-world-open"));
    }
    if (state.user.role === "teacher") {
      const name = inputField("新しい教室の名前", { value: "岡崎駅 クラスワールド", maxLength: 40, id: "school-world-name" });
      section.append(element("h3", "先生：教室を作る"), name.label,
        command("教室を作成", () => perform(() => client.createWorld(name.input.value), "教室を作成しました。招待URLまたはコードを生徒に配ってください。"), "school-world-create"));
    }
    content.append(section);
  }
  function renderRoom() {
    if (!state.world) return;
    const section = element("section", undefined, "school-section school-current"); section.id = "school-current-world";
    section.append(element("h3", `現在の教室：${state.world.name}`));
    participantLabel = element("p", undefined, "school-note"); participantLabel.id = "school-participants";
    roomConnection = element("p", undefined, "school-note"); roomConnection.id = "school-connection";
    section.append(participantLabel, roomConnection, element("p", "自分が読み込んだSTLだけを配置・変更できます。作品は教室に保存され、ほかの参加者にも見えます。", "school-note"));
    const actions = element("div", undefined, "school-actions");
    actions.append(command("教室を退出", () => client.leaveWorld(), "school-world-leave")); section.append(actions);
    if (state.world.joinCode && state.user.role === "teacher") {
      section.append(element("p", "生徒に配る参加コード", "school-note"));
      const code = element("code", state.world.joinCode, "school-invite-code"); code.id = "school-invite-code"; section.append(code);
      const invite = inputField("配布用URL（閲覧のみでは参加しません）", { value: schoolInviteURL(globalThis.location.origin, state.world.joinCode), id: "school-invite-url" });
      invite.input.readOnly = true; section.append(invite.label);
      section.append(command("招待URLをコピー", async () => {
        try { await navigator.clipboard.writeText(invite.input.value); setStatus("招待URLをコピーしました。Classroomなどで配ってください。"); }
        catch { invite.input.focus(); invite.input.select(); setStatus("URL欄を選択しました。ブラウザのコピー操作でコピーしてください。"); }
      }, "school-invite-copy"));
      section.append(element("h3", "先生：クラウド保存・復元"), element("p", "配置は随時クラウドへ保存されます。「授業の状態を保存」は全員の位置・作品の復元ポイントを残します。", "school-note"));
      section.append(command("授業の状態を保存", () => perform(() => client.saveWorld(), "全員の位置と作品を復元ポイントに保存しました。"), "school-world-save", state.connection !== "connected"));
      if (state.snapshots.length) {
        const select = element("select"); select.id = "school-snapshot-list"; select.setAttribute("aria-label", "復元ポイント");
        for (const snapshot of state.snapshots) {
          const item = element("option", `${new Date(snapshot.createdAt * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} · rev ${snapshot.revision}`); item.value = snapshot.id; select.append(item);
        }
        const confirmation = element("div", undefined, "school-restore-confirm"); confirmation.hidden = true;
        confirmation.append(element("p", "全員の作品と位置が選んだ保存時点に戻ります。現在の変更はその時点に巻き戻されます。復元しますか？"));
        let selectedSnapshot = null;
        const confirm = command("全員のワールドを復元する", () => perform(async () => {
          await client.restoreWorld(selectedSnapshot); confirmation.hidden = true;
        }, "全員のワールドを復元しました。"), "school-restore-confirm", state.connection !== "connected");
        confirmation.append(confirm, actionButton("取り消し", () => { confirmation.hidden = true; }));
        section.append(select, command("選んだ保存時点へ復元…", () => { selectedSnapshot = select.value; confirmation.hidden = false; confirm.focus(); }, "school-world-restore", state.connection !== "connected"), confirmation);
      }
    }
    content.append(section);
  }
  function updateConnection() {
    const description = state.connection === "connected" ? "接続中：共同活動できます" : state.connection === "reconnecting" ? "再接続中：作品操作は一時停止" : state.world ? "接続待ち・停止中：作品操作はできません" : "教室を選んでください";
    if (roomConnection) roomConnection.textContent = description;
    if (participantLabel) participantLabel.textContent = `参加者 ${state.participants.length} / 31人 · 作品 ${state.objects.length}点`;
    if (summary) summary.textContent = state.user ? `${state.user.role === "teacher" ? "先生" : "生徒"} · ${state.world ? `${state.world.name} · ${description}` : "未参加"}` : "ゲスト：VR閲覧のみ（共同活動はログイン後）";
    if (button) button.textContent = state.user ? "共同教室・アカウント" : "共同教室 / ログイン";
    for (const node of dialog.querySelectorAll("#school-world-save,#school-world-restore,#school-restore-confirm")) node.dataset.unavailable = String(state.connection !== "connected");
    refreshDisabled();
  }
  function render(next, event) {
    state = next;
    // High-frequency single-player pose updates only affect the 3D scene. They
    // must not rebuild the login form or announce every movement to screenreaders.
    if (event === "pose") return;
    const key = JSON.stringify({ configured: state.configured, user: state.user, world: state.world, worlds: state.worlds, snapshots: state.snapshots });
    if (key !== renderKey) {
      renderKey = key; googleGeneration++; googleHost = participantLabel = roomConnection = null;
      content.replaceChildren();
      if (!state.user) renderGuest(); else { renderAccount(); renderEntry(); renderRoom(); }
    }
    updateConnection();
    if (state.error) setStatus(explainSchoolError(state.error), true);
    else if (event === "auth" || event === "state") setStatus(state.user ? "ログイン中です。教室を選んで参加してください。" : "ログインせず街を見ることもできます。");
  }
  async function open() {
    const allowed = await onBeforeOpen();
    if (allowed === false) {
      if (summary) summary.textContent = "Googleログイン・教室の操作は、VRを終了して2Dブラウザへ戻ってから行ってください。";
      return false;
    }
    if (!dialog.open) dialog.showModal(); return true;
  }
  const clickOpen = () => { open().catch(() => {}); };
  button?.addEventListener("click", clickOpen);
  const unsubscribe = client.subscribe(render);
  dialog.addEventListener("close", () => {
    googleGeneration++;
    // A rendered GIS button is bound to the old callback/challenge generation.
    // Remove it on close rather than leaving a visible button that silently
    // ignores sign-in after the dialog is reopened.
    googleHost?.replaceChildren(element("p", "ログインする場合は、もう一度「Googleログインを表示」を押してください。", "school-note"));
    try { globalThis.google?.accounts?.id?.cancel(); } catch { /* No global revoke. */ }
  });
  return { open, close: () => dialog.close(), isOpen: () => dialog.open, dialog,
    destroy: () => { unsubscribe(); googleGeneration++; button?.removeEventListener("click", clickOpen); dialog.remove(); } };
}
