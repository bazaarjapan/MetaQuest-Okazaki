import { parseSchoolInvite, schoolInviteURL } from "./school-client.js";
import { createGoogleIdentityLoader } from "./google-identity.js";
import "./school.css";
import { describeWorkLocation, exhibitTitle } from "./workshop-presentation.js";

const ERROR_TEXT = {
  invalid_student_login: "IDまたはパスワードが違います。先生から受け取った内容を確認してください。",
  student_id_required: "Googleログインは登録済みの先生専用です。生徒は先生が発行したID・パスワードを使ってください。",
  name_required: "最初にアバターの名前を入力してください。",
  name_taken: "その名前は先生または別の生徒が使っています。別の名前にしてください（英字の大文字・小文字は区別しません）。",
  invalid_avatar_name: "名前は20文字以内で、見える文字を使ってください。メールアドレスや見えない制御文字は使えません。",
  invalid_name: "名前を1〜20文字で入力してください。",
  classroom_not_ready: "先生がログインするとワールドが準備されます。",
  school_not_configured: "共同教室は準備中です。先生に確認してから再接続してください。",
  school_unavailable: "共同教室に接続できません。接続が戻るまで操作を停止しています。",
  login_required: "ログインが必要です。生徒はID・パスワード、先生はGoogleでログインしてください。",
  invalid_join_code: "先生から受け取った12文字の参加コード、または招待URLを入力してください。",
  join_code_not_found: "参加コードが見つかりません。先生に確認してください。",
  class_full: "この教室は30人の生徒で満員です。先生に確認してください。",
  teacher_full: "このワールドに登録できる先生は4人までです。管理者に確認してください。",
  room_full: "同時参加人数の上限に達しました。しばらくしてからもう一度開いてください。",
  other_teacher_world: "先生は自分が作成した教室のみ開けます。",
  teacher_required: "この操作はワールドを作成した先生だけができます。",
  object_not_found: "この作品はすでに回収されています。生徒一覧を確認してください。",
  object_owner_required: "この作品を操作する権限がありません。",
  stale_revision: "ほかの人の変更が先に保存されました。最新状態に更新したので、内容を確認してもう一度操作してください。",
  session_expired: "ログイン期限が切れました。生徒はID・パスワード、先生はGoogleでログインし直してください。",
  room_login_required: "ログインまたは教室への参加が必要です。",
  connected_elsewhere: "同じアカウントで別のタブ・端末が参加しました。こちらでは活動を停止しました。",
  connection_lost: "通信が切れました。接続が戻るまで作品の操作はできません。",
  connection_closed: "ワールドとの接続が閉じられました。共同教室の画面から再接続してください。",
  request_timeout: "応答を確認できませんでした。保存状態を確認してから再操作してください。",
  edit_timeout: "配置の応答を確認できません。最新状態を読み直してから確認してください。",
  restore_recovery_pending: "ワールドの復元を安全に確認しています。少し待って再接続してください。",
  login_rate_limit: "ログインの試行が多いため、1分ほど待ってからやり直してください。",
  gis_unavailable: "Googleログインを読み込めませんでした。通信・ブラウザの制限を確認し、もう一度お試しください。",
  invalid_csrf: "ログインの準備が更新されました。生徒はID・パスワードで再試行し、先生はGoogleログインを表示し直してください。",
  already_logged_in: "このブラウザではログイン済みです。教室を選んで参加してください。",
  google_keys_unavailable: "Googleの本人確認に必要な公開鍵を取得できませんでした。1分ほど待ってから、もう一度Googleログインを表示してください。",
  invalid_token: "Googleのログイン情報を確認できませんでした。もう一度Googleログインを表示し、アカウントを選び直してください。",
  login_challenge_required: "ログインの準備情報が見つかりません。生徒はIDで再試行し、先生はGoogleログインを表示し直してください。続く場合は、このサイトのCookieが許可されているか確認してください。",
  login_challenge_expired: "ログインの準備が期限切れ、または使用済みです。生徒はIDで再試行し、先生はGoogleログインを表示し直してください。",
  invalid_origin: "ログインするページのURLを確認できませんでした。https://metaquest001.gigach.net/ を開き直してお試しください。",
  login_cancelled: "ログイン中にアカウントの状態が変わりました。現在の状態を確認し、生徒はIDで再試行、先生はGoogleログインを表示し直してください。",
  login_failed: "ログインの通信を完了できませんでした。通信を確認して、生徒はIDで再試行、先生はGoogleログインを表示し直してください。",
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

export function createSchoolUI({ client, button, onBeforeOpen = () => {},
  onLocateObject = async () => false, getViewPosition = () => ({x:0,z:0}), getStation = () => null }) {
  const dialog = element("dialog", undefined, "school-dialog"); dialog.id = "school-dialog";
  dialog.setAttribute("aria-labelledby", "school-title");
  const heading = element("div", undefined, "school-heading");
  const title = element("h2", "共同教室", "school-title"); title.id = "school-title";
  const closeButton = actionButton("閉じる", () => dialog.close(), "school-close"); heading.append(title, closeButton);
  const description = element("p", "みんなで1つのワールドを使います。操作はログイン後に使えます。生徒は先生から受け取ったID、先生は登録済みGoogleアカウントで入ります。", "school-note");
  const status = element("p", "接続確認中…", "school-status"); status.id = "school-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const movementStatus = element("p", "", "school-note"); movementStatus.id = "school-movement-status"; movementStatus.hidden = true;
  movementStatus.setAttribute("role", "status"); movementStatus.setAttribute("aria-live", "polite");
  const content = element("div", undefined, "school-content");
  const privacy = element("a", "ログイン・作品保存について（プライバシー）"); privacy.href = "/privacy.html";
  dialog.append(heading, description, status, movementStatus, content, privacy); document.body.append(dialog);
  const summary = document.querySelector("#school-summary");
  let state = client.getState(), renderKey = "", busy = false, googleGeneration = 0;
  let googleHost = null, participantLabel = null, roomConnection = null;
  let issuedCredentials = [], credentialsOwner = null;
  let updateRoster = () => {};
  const inviteCode = parseSchoolInvite(globalThis.location?.href ?? "");
  function setStatus(text, error = false) { if (status.textContent !== text) status.textContent = text; status.classList.toggle("is-error", error); }
  function updateMovementStatus() {
    const text = state.movementWarning === "pose_rate_limit" ? "移動の共有を一時的に制限しています。少し待って移動してください。" : "";
    if (movementStatus.textContent !== text) movementStatus.textContent = text;
    movementStatus.hidden = !text;
  }
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
          await perform(() => client.login(response.credential), "ログインしました。");
          if (!client.getState().user && generation === googleGeneration) {
            host.replaceChildren(element("p", "ログインを表示し直してから再試行してください。", "school-note"));
          }
        } });
      googleId.renderButton(host, { type: "standard", theme: "outline", size: "large", text: "signin_with", shape: "rectangular", width: Math.max(220, Math.min(320, dialog.clientWidth - 50)), locale: "ja" });
      setStatus("Googleのボタンでログインしてください。");
    });
  }
  function renderGuest() {
    if (state.singleClassroom) {
      const form = element("form", undefined, "school-section");
      form.append(element("h3", "生徒：IDで入る"));
      form.append(element("p", "初回はログイン後に名前を決めます。次回は同じID・パスワードで、名前・自分のSTL・配置した場所を引き継げます。", "school-note"));
      const id = inputField("ID", { id: "student-login-id", maxLength: 40 }); id.input.autocomplete = "username";
      const password = inputField("パスワード", { id: "student-password", type: "password", maxLength: 128 }); password.input.autocomplete = "current-password";
      const submit = element("button", "ワールドに入る"); submit.type = "submit"; submit.dataset.schoolAction = "true";
      form.append(id.label, password.label, submit);
      form.addEventListener("submit", event => { event.preventDefault(); void perform(async () => {
        const secret = password.input.value; password.input.value = "";
        await client.loginStudent(id.input.value, secret);
      }); });
      content.append(form);
    }
    const section = element("section", undefined, "school-section");
    section.append(element("h3", state.singleClassroom ? "先生：Googleで入る" : "1. Googleでログイン"), element("p", "先生として登録済みのGoogleアカウントを使います。", "school-note"));
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
    if (state.user.namePending) section.append(element("p", state.user.nameConflict
      ? "以前の名前がほかの人と重複しています。別の名前を決めてください。あなたのSTL・配置場所はそのまま残っています。"
      : "最初に、みんなに見える名前を決めましょう。本名でなくても大丈夫です。保存するとワールドに入ります。"));
    section.append(element("p", "先生・生徒で同じ名前は使えません。名前を変えても自分の作品は引き継がれます。", "school-note"));
    const name = inputField("頭の上に表示する名前（20文字まで）", { value: state.user.namePending ? "" : state.user.name, maxLength: 40, id: "school-avatar-name" });
    const color = inputField("色", { type: "color", value: state.user.color, id: "school-avatar-color" });
    row.append(name.label, color.label); section.append(row);
    const actions = element("div", undefined, "school-actions");
    actions.append(command(state.user.namePending ? "この名前でワールドに入る" : "アバターを保存", () => perform(() => client.updateAvatar({ name: name.input.value, color: color.input.value }), "名前と色を保存しました。次回も同じIDで続きを開けます。"), "school-avatar-save"),
      command("ログアウト", () => perform(() => client.logout(), "ログアウトしました。操作を再開するにはログインしてください。"), "school-logout"));
    section.append(actions); content.append(section);
  }
  function renderEntry() {
    if (state.user.namePending) return;
    if (state.singleClassroom) {
      if (!state.user.namePending && state.connection !== "connected") content.append(command("ワールドに接続", () => perform(() => client.enterClassroom()), "school-classroom-enter"));
      if (state.user.role === "teacher") renderStudents();
      return;
    }
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
  function renderStudents() {
    const section = element("section", undefined, "school-section"); section.append(element("h3", "先生：生徒のIDを発行（最大30人）"));
    const count = inputField("発行する人数", { type: "number", value: "1", id: "student-issue-count" }); count.input.min = "1"; count.input.max = "30";
    const output = element("textarea"); output.id = "student-issued-credentials"; output.readOnly = true; output.hidden = !issuedCredentials.length; output.rows = 8; output.setAttribute("aria-label", "今回発行したIDとパスワード");
    const credentialText = () => "ID\tパスワード\n" + issuedCredentials.map(row => `${row.loginId}\t${row.password}`).join("\n");
    if (issuedCredentials.length) output.value = credentialText();
    const note = element("p", "パスワードは発行・再発行した時だけ表示します。各生徒に自分の1行だけを安全に渡してください。再発行しても名前・作品は残ります。", "school-note");
    const roster = element("div"); roster.id = "student-roster-list";
    let students = null, rosterKey = "";
    const showSecrets = result => {
      // Socket arrival may rerender the dialog during issuance. Keep this one
      // response in volatile UI memory and update the CURRENT textarea, not a
      // detached closure node. Never persist passwords in browser storage.
      issuedCredentials = result.credentials; credentialsOwner = state.user?.id;
      const current = dialog.querySelector("#student-issued-credentials") ?? output;
      current.hidden = false; current.value = credentialText();
      current.focus(); current.select();
    };
    async function refreshRoster() {
      const owner = state.user?.id, world = state.world?.id;
      const result = await client.students();
      if (!roster.isConnected || state.user?.id !== owner || state.world?.id !== world) return;
      students = result.students; rosterKey = ""; updateRoster();
    }
    updateRoster = () => {
      if (!students || !roster.isConnected) return;
      const key = JSON.stringify([state.world?.id, state.connection, state.objects]);
      if (key === rosterKey) return;
      rosterKey = key; roster.replaceChildren();
      roster.append(element("p", `発行済み ${students.length} / 30人 · 配置はリアルタイム更新`));
      for (const student of students) {
        const row = element("section", undefined, "student-placement-row");
        row.dataset.studentId = student.id;
        row.append(element("h4", `${student.slot}. ${student.name} (${student.loginId})`), command("パスワード再発行", () => {
          if (!confirm("この生徒の古いパスワードを無効にして再発行しますか？作品は残ります。")) return;
          void perform(async () => showSecrets(await client.students("reset", { id: student.id })), "新しいパスワードを本人に渡してください。");
        }));
        const objects = state.objects.filter(item => item.ownerId === student.id);
        row.append(element("p", state.connection !== "connected" ? "再接続後に配置を確認できます。" :
          objects.length ? `配置中 ${objects.length}点` : "配置中の作品はありません。", "school-note"));
        for (const item of objects) {
          const card = element("div", undefined, "student-work");
          card.dataset.objectId = item.id;
          card.append(element("strong", exhibitTitle(item)),
            element("p", describeWorkLocation(item.position, getViewPosition(), getStation()), "school-note"));
          if (item.description) card.append(element("p", item.description, "school-note"));
          card.append(command("📍 作品を見に行く", () => perform(async () => {
            dialog.close();
            if (!await onLocateObject(item.id)) {
              await open(); setStatus("作品の地面を確認できませんでした。読み込み後にもう一度お試しください。", true);
            }
          }), undefined, state.connection !== "connected"));
          card.append(command("生徒のホットバーへ戻す", () => perform(async () => {
            await client.editObject("object.delete", { id: item.id });
          }, `「${exhibitTitle(item)}」の配置を解除しました。${student.name}のSTLはホットバーから再び使えます。`),
          undefined, state.connection !== "connected"));
          row.append(card);
        }
        roster.append(row);
      }
      refreshDisabled();
    };
    section.append(count.label, command("ID・パスワードを発行", () => perform(async () => {
      showSecrets(await client.students("issue", { count: Number(count.input.value) })); await refreshRoster();
    }, "発行しました。表示された情報を控えてください。"), "student-issue"), note, output,
    command("生徒一覧を確認", () => perform(refreshRoster), "student-roster"), roster);
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
      if (!state.singleClassroom) {
      section.append(element("p", "生徒に配る参加コード", "school-note"));
      const code = element("code", state.world.joinCode, "school-invite-code"); code.id = "school-invite-code"; section.append(code);
      const invite = inputField("配布用URL（閲覧のみでは参加しません）", { value: schoolInviteURL(globalThis.location.origin, state.world.joinCode), id: "school-invite-url" });
      invite.input.readOnly = true; section.append(invite.label);
      section.append(command("招待URLをコピー", async () => {
        try { await navigator.clipboard.writeText(invite.input.value); setStatus("招待URLをコピーしました。Classroomなどで配ってください。"); }
        catch { invite.input.focus(); invite.input.select(); setStatus("URL欄を選択しました。ブラウザのコピー操作でコピーしてください。"); }
      }, "school-invite-copy"));
      }
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
    if (state.singleClassroom) { const entry = dialog.querySelector("#school-classroom-enter"); if (entry) entry.hidden = state.connection === "connected"; }
    const description = state.connection === "connected" ? "接続中：共同活動できます" : state.connection === "reconnecting" ? "再接続中：作品操作は一時停止" : state.world ? "接続待ち・停止中：作品操作はできません" : "教室を選んでください";
    if (roomConnection) roomConnection.textContent = description;
    if (participantLabel) participantLabel.textContent = `参加者 ${state.participants.length}人（生徒最大30人） · 作品 ${state.objects.length}点`;
    if (summary) summary.textContent = state.user ? `${state.user.role === "teacher" ? "先生" : "生徒"} · ${state.world ? `${state.world.name} · ${description}` : "未参加"}` : "未ログイン：ログイン後に操作できます";
    if (button) button.textContent = state.user ? "共同教室・アカウント" : "共同教室 / ログイン";
    for (const node of dialog.querySelectorAll("#school-world-save,#school-world-restore,#school-restore-confirm")) node.dataset.unavailable = String(state.connection !== "connected");
    refreshDisabled();
  }
  function render(next, event) {
    state = next;
    if (credentialsOwner !== state.user?.id) { issuedCredentials = []; credentialsOwner = state.user?.id; }
    updateMovementStatus();
    // High-frequency single-player pose updates only affect the 3D scene. They
    // must not rebuild the login form or announce every movement to screenreaders.
    if (event === "pose") return;
    const key = JSON.stringify({ configured: state.configured, user: state.user, world: state.world, worlds: state.worlds, snapshots: state.snapshots });
    if (key !== renderKey) {
      renderKey = key; googleGeneration++; googleHost = participantLabel = roomConnection = null;
      content.replaceChildren();
      if (!state.user) renderGuest(); else { renderAccount(); renderEntry(); if (!state.user.namePending) renderRoom(); }
    }
    updateConnection();
    updateRoster();
    if (state.error) setStatus(explainSchoolError(state.error), true);
    else if (event === "auth" || event === "state") setStatus(state.user ? (state.user.namePending ? "頭の上に表示する名前を決めてください。" : "ログイン中です。みんなのワールドに接続します。") : "ログインすると、街の移動・VR・作品づくりを始められます。");
  }
  async function open() {
    const allowed = await onBeforeOpen();
    if (allowed === false) {
      if (summary) summary.textContent = "ログイン・教室の操作は、VRを終了して2Dブラウザへ戻ってから行ってください。";
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
