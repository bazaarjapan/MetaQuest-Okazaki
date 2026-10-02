// Identity and room writes go only to the same-origin Worker. Tokens are never
// persisted in browser storage; the server owns the HttpOnly session cookie.
const clone = (value) => structuredClone(value);
function readonlySnapshotFactory() {
  const cache = new WeakMap();
  function snapshot(value) {
    if (!value || typeof value !== "object") return value;
    if (cache.has(value)) return cache.get(value);
    const copy = Array.isArray(value) ? [] : {};
    cache.set(value, copy);
    for (const [key, entry] of Object.entries(value)) copy[key] = snapshot(entry);
    return Object.freeze(copy);
  }
  return snapshot;
}
const codePattern = /^[A-Z0-9_-]{12}$/i;
const idPattern = /^[a-f0-9-]{36}$/;
export function parseSchoolInvite(value) {
  try {
    const fragment = new URL(value, "https://example.invalid/").hash.slice(1);
    const code = new URLSearchParams(fragment).get("join");
    return code && codePattern.test(code) ? code.toUpperCase() : null;
  } catch { return null; }
}
export function schoolInviteURL(origin, code) {
  if (!codePattern.test(code)) throw new Error("invalid_join_code");
  const url = new URL(origin); url.search = ""; url.hash = `join=${code.toUpperCase()}`;
  return url.href;
}
export class SchoolClientError extends Error {
  constructor(code, status = 0) { super(code); this.name = "SchoolClientError"; this.code = code; this.status = status; }
}

export function createSchoolClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const origin = new URL(options.origin ?? globalThis.location?.origin ?? "https://metaquest001.gigach.net").origin;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? globalThis.clearTimeout;
  const setEvery = options.setIntervalImpl ?? globalThis.setInterval;
  const clearEvery = options.clearIntervalImpl ?? globalThis.clearInterval;
  const state = { configured: false, user: null, world: null, worlds: [], assets: [], objects: [], participants: [], snapshots: [], revision: 0, restoreCommit: null, snapshotSeq: 0, connection: "guest", error: null, movementWarning: null };
  const listeners = new Set(), pending = new Map();
  const readonlySnapshot = readonlySnapshotFactory();
  let csrf = null, nonce = null, clientId = null, authEpoch = 0, roomEpoch = 0;
  let socket = null, heartbeat = null, reconnectTimer = null, openingTimer = null, retry = 0;
  let poseSeq = 0, lastPoseAt = -Infinity, lastEditAt = -Infinity, lastFullStateRevision = -1, initialized = null, sessionRefresh = null;
  let editTail = Promise.resolve();
  let metadataRefresh = null;
  let movementRecoveryTimer = null;
  function cancelMovementRecovery() {
    if (movementRecoveryTimer !== null) clearTimer(movementRecoveryTimer);
    movementRecoveryTimer = null;
  }
  const getState = () => clone(state);
  function emit(event = "state") {
    // Share one immutable snapshot with all subscribers. Unchanged world/assets/
    // objects retain their cached readonly view, so30players' 8Hz pose traffic
    // does not repeatedly clone every STL object for every subscriber.
    const snapshot = readonlySnapshot({ ...state });
    for (const listener of listeners) { try { listener(snapshot, event); } catch { /* One view must not disable the others. */ } }
  }
  function clearRoom(code = "room_changed", keepWorld = false) {
    cancelMovementRecovery();
    roomEpoch++;
    if (heartbeat !== null) clearEvery(heartbeat);
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    if (openingTimer !== null) clearTimer(openingTimer);
    heartbeat = reconnectTimer = openingTimer = null;
    const old = socket; socket = null;
    try { old?.close(1000, "room left"); } catch { /* Already closed. */ }
    for (const item of pending.values()) { clearTimer(item.timer); item.reject(new SchoolClientError(code)); }
    pending.clear(); retry = 0; poseSeq = 0; lastPoseAt = lastEditAt = -Infinity; lastFullStateRevision = -1; metadataRefresh = null;
    editTail = Promise.resolve();
    if (!keepWorld) { state.world = null; state.assets = []; state.objects = []; state.snapshots = []; state.revision = 0; }
    state.restoreCommit = null; state.participants = []; state.movementWarning = null; state.connection = state.user ? "idle" : "guest";
  }
  function clearIdentity(code = "login_required") {
    authEpoch++; clearRoom(code ?? "signed_out"); csrf = nonce = null;
    state.user = null; state.worlds = []; state.connection = "guest"; state.error = code;
    emit("auth");
  }
  async function request(path, { method = "GET", body, headers = {}, binary = false, csrfValue = csrf } = {}) {
    const epoch = authEpoch, controller = new AbortController();
    const timer = setTimer(() => controller.abort(), 20000);
    try {
      const response = await fetchImpl(`${origin}${path}`, { method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { ...(body !== undefined && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) ? { "Content-Type": "application/json" } : {}),
          ...(method !== "GET" && csrfValue ? { "X-CSRF-Token": csrfValue } : {}), ...headers },
        ...(body === undefined ? {} : { body: body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body : JSON.stringify(body) }) });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        const code = typeof failure.error === "string" ? failure.error : `http_${response.status}`;
        if (response.status === 401 && epoch === authEpoch) clearIdentity(code);
        throw new SchoolClientError(code, response.status);
      }
      return binary ? await response.arrayBuffer() : await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw new SchoolClientError("request_timeout");
      throw error;
    } finally { clearTimer(timer); }
  }
  function assertUser() { if (!state.user) throw new SchoolClientError("login_required", 401); }
  function assertRoom() { assertUser(); if (!state.world) throw new SchoolClientError("room_required"); return state.world.id; }
  function assertEpoch(epoch, room, worldId) {
    if (epoch !== authEpoch || room !== roomEpoch || state.world?.id !== worldId) throw new SchoolClientError("room_changed");
  }
  async function loadWorlds(epoch = authEpoch) {
    const result = await request("/api/worlds");
    if (epoch !== authEpoch) return;
    state.worlds = Array.isArray(result.worlds) ? result.worlds : []; emit("worlds");
  }
  function refreshSession() {
    const epoch = authEpoch;
    if (sessionRefresh?.epoch === epoch) return sessionRefresh.promise;
    const refresh = { epoch, promise: null };
    refresh.promise = (async () => {
      const result = await request("/api/session");
      if (epoch !== authEpoch) return getState();
      if (!result.user && state.user) clearIdentity("session_expired");
      else if (result.user && state.user && result.user.id !== state.user.id) {
        // Another tab can replace the same-origin cookie. Its identity must never
        // inherit this tab's previous user's active socket or pending commands.
        authEpoch++; clearRoom("identity_changed"); state.worlds = [];
      }
      csrf = result.csrf ?? null; nonce = result.nonce ?? null; state.user = result.user ?? null;
      if (!state.world) state.connection = state.user ? "idle" : "guest";
      state.error = null; emit("auth");
      if (state.user) await loadWorlds();
      return getState();
    })().finally(() => { if (sessionRefresh === refresh) sessionRefresh = null; });
    sessionRefresh = refresh;
    return refresh.promise;
  }
  function init({ recheck = false } = {}) {
    // Failures/unconfigured responses are retryable on a deliberate call. Keep
    // only successful initialization cached; never start a background retry loop.
    // A recheck shares an in-flight attempt instead of creating nonce/cookie races.
    if (initialized && (initialized.pending || !recheck)) return initialized.promise;
    const epoch = authEpoch, attempt = { pending: true, promise: null };
    attempt.promise = (async () => {
      let complete = false;
      try {
        const result = await request("/api/config");
        if (epoch !== authEpoch) return getState();
        state.configured = result.configured === true;
        clientId = typeof result.googleClientId === "string" ? result.googleClientId : null;
        if (state.configured && clientId) {
          await refreshSession();
          complete = epoch === authEpoch && !state.error;
        }
        else { state.error = "school_not_configured"; emit("auth"); }
      } catch (error) {
        // A late failed recheck must not sign out a newer successful login.
        if (epoch === authEpoch) clearIdentity(error.code ?? "school_unavailable");
      } finally {
        attempt.pending = false;
        if (initialized === attempt && !complete) initialized = null;
      }
      return getState();
    })();
    initialized = attempt;
    return attempt.promise;
  }
  async function prepareGoogleLogin() {
    await init();
    if (!state.configured || !clientId) throw new SchoolClientError("school_not_configured", 503);
    await refreshSession();
    if (state.user) throw new SchoolClientError("already_logged_in");
    if (!nonce || !csrf) throw new SchoolClientError("login_challenge_required");
    return { clientId, nonce };
  }
  async function login(credential) {
    if (typeof credential !== "string" || !credential || credential.length > 16000) throw new SchoolClientError("invalid_token");
    if (!csrf || !nonce) throw new SchoolClientError("login_challenge_required");
    const epoch = authEpoch;
    try {
      const result = await request("/api/auth/google", { method: "POST", body: { credential, csrf } });
      if (epoch !== authEpoch) throw new SchoolClientError("login_cancelled");
      authEpoch++; clearRoom(); csrf = result.csrf; nonce = null; state.user = result.user; state.error = null; state.connection = "idle";
      emit("auth"); await loadWorlds(); return getState();
    } catch (error) {
      // A challenge can expire or be consumed on another tab. Reacquire only
      // through the server, never replay a stored Google ID token automatically.
      try { await refreshSession(); } catch { /* The dialog offers retry while guest VR stays usable. */ }
      state.error = error.code ?? "login_failed"; emit("auth"); throw error;
    }
  }
  async function logout() {
    assertUser();
    try { await request("/api/auth/logout", { method: "POST", body: {} }); }
    finally { clearIdentity(null); }
    try { await refreshSession(); } catch { /* No local edit session survives sign-out. */ }
  }
  function applySnapshot(value) {
    if (!value.world || value.world.id !== state.world?.id || !Number.isSafeInteger(value.revision)) return;
    // Assets are immutable and have no deletion API; metadata can arrive in an
    // older HTTP response even after a newer object broadcast. Keep that useful
    // metadata without rolling authoritative objects/revision backwards.
    if (Array.isArray(value.assets)) {
      const assets = new Map(state.assets.map((asset) => [asset.id, asset]));
      for (const asset of value.assets) if (asset?.id) assets.set(asset.id, clone(asset));
      state.assets = [...assets.values()];
    }
    if (value.revision < state.revision) return;
    state.world = clone(value.world); state.revision = value.revision;
    for (const key of ["objects", "participants", "snapshots"]) if (Array.isArray(value[key])) state[key] = clone(value[key]);
  }
  async function refreshWorld(epoch = authEpoch, room = roomEpoch, worldId = assertRoom()) {
    const result = await request(`/api/worlds/${worldId}/state`);
    assertEpoch(epoch, room, worldId); applySnapshot(result); emit("room"); return result;
  }
  function connect(worldId, epoch, room) {
    if (epoch !== authEpoch || room !== roomEpoch || !state.user || state.world?.id !== worldId) return;
    if (!WebSocketImpl) { state.connection = "offline"; state.error = "websocket_unavailable"; emit("connection"); return; }
    const address = new URL(`/api/worlds/${worldId}/socket`, origin); address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    let live;
    try { live = new WebSocketImpl(address.href); } catch { scheduleReconnect(); return; }
    socket = live; state.connection = retry ? "reconnecting" : "connecting"; emit("connection");
    const current = () => live === socket && epoch === authEpoch && room === roomEpoch;
    openingTimer = setTimer(() => { if (current() && state.connection !== "connected") live.close(1011, "state timed out"); }, 12000);
    function scheduleReconnect() {
      if (epoch !== authEpoch || room !== roomEpoch || !state.user || retry >= 6) { state.connection = "offline"; state.error = "connection_lost"; emit("connection"); return; }
      state.connection = "reconnecting"; emit("connection");
      const delay = Math.min(15000, 1000 * 2 ** retry++);
      reconnectTimer = setTimer(async () => {
        reconnectTimer = null;
        try { await refreshWorld(epoch, room, worldId); connect(worldId, epoch, room); }
        catch (error) { if (epoch === authEpoch && room === roomEpoch) { state.error = error.code ?? "connection_lost"; scheduleReconnect(); } }
      }, delay);
    }
    live.onopen = () => {
      if (!current()) { live.close(); return; }
      heartbeat = setEvery(() => { if (current() && live.readyState === 1) live.send(JSON.stringify({ type: "ping" })); }, 20000);
    };
    live.onmessage = ({ data }) => {
      if (!current() || typeof data !== "string" || data.length > 1024 * 1024) return;
      let value; try { value = JSON.parse(data); } catch { return; }
      if (!value || typeof value !== "object") return;
      if (value.type === "state") {
        if (value.world?.id !== worldId || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision < lastFullStateRevision) return;
        if (value.restoreCommit !== null && !(typeof value.restoreCommit === "string" && idPattern.test(value.restoreCommit))) {
          live.close(1011, "invalid pose epoch"); return;
        }
        cancelMovementRecovery();
        applySnapshot(value); state.connection = "connected"; state.error = null; state.movementWarning = null; retry = 0;
        // HTTP metadata/object reads can overtake a restore broadcast. Preserve
        // their newer object revision, but still adopt this ordered live camera
        // snapshot. Compare full WS states with each other, not with HTTP reads.
        lastFullStateRevision = value.revision;
        if (Array.isArray(value.participants)) state.participants = clone(value.participants);
        // Only a full live snapshot also adopts the camera (snapshotSeq). An
        // earlier HTTP read must not label an old camera pose with a new epoch.
        state.restoreCommit = value.restoreCommit;
        state.snapshotSeq++;
        if (openingTimer !== null) clearTimer(openingTimer); openingTimer = null;
        emit("room");
      } else if (value.type === "participants" && Array.isArray(value.participants)) { state.participants = clone(value.participants); emit("participants"); }
      else if (value.type === "pose" && value.participant?.id) {
        // Only our server-accepted movement proves recovery. Peer movement and
        // edit ACKs cannot confirm that this participant is no longer limited.
        if (value.participant.id === state.user?.id && state.movementWarning && movementRecoveryTimer === null) {
          // A short quiet period keeps alternating accepted/rejected bursts
          // from flashing and repeatedly announcing the same warning.
          movementRecoveryTimer = setTimer(() => {
            movementRecoveryTimer = null;
            if (current()) { state.movementWarning = null; emit("movement"); }
          }, 1000);
        }
        const index = state.participants.findIndex((item) => item.id === value.participant.id);
        const participants = [...state.participants];
        if (index >= 0) participants[index] = clone(value.participant);
        else participants.push(clone(value.participant));
        state.participants = participants;
        emit("pose");
      } else if (value.type === "objects" && Array.isArray(value.objects) && Number.isSafeInteger(value.revision) && value.revision >= state.revision) {
        state.objects = clone(value.objects); state.revision = value.revision; emit("objects");
        // A peer's new placement can arrive before that STL's metadata is in
        // this client. Refresh a complete authenticated snapshot once, not per
        // participant/pose, so the renderer can verify/download private bytes.
        if (!metadataRefresh && state.objects.some((object) => object.assetId && !state.assets.some((asset) => asset.id === object.assetId))) {
          const refresh = (async () => {
            // At most three coalesced reads cover objects arriving while the
            // previous response is in flight. No per-pose reads or busy loop.
            for (let pass = 0; pass < 3; pass++) {
              await refreshWorld(epoch, room, worldId);
              if (!state.objects.some((object) => object.assetId && !state.assets.some((asset) => asset.id === object.assetId))) return;
            }
            throw new SchoolClientError("asset_metadata_unavailable");
          })();
          metadataRefresh = refresh;
          refresh.catch((error) => { if (current()) { state.error = error.code ?? "asset_metadata_unavailable"; emit("error"); } })
            .finally(() => { if (metadataRefresh === refresh) metadataRefresh = null; });
        }
      } else if (value.type === "ack" && pending.has(value.requestId)) {
        const item = pending.get(value.requestId); pending.delete(value.requestId); clearTimer(item.timer);
        if (Number.isSafeInteger(value.revision)) state.revision = Math.max(state.revision, value.revision);
        item.resolve(clone(value));
      } else if (value.type === "error") {
        // In-flight movement from before a teacher restore is expected to be
        // rejected. Do not turn that safe rejection into an auth/edit failure;
        // the authoritative full WS snapshot owns the next movement epoch.
        if (value.error === "stale_pose_epoch") return;
        // Pose has no request ID or mutation ACK. Keep correlated errors on the
        // existing failure path, even if their code happens to match this one.
        if (value.error === "pose_rate_limit" && !Object.hasOwn(value, "requestId")) {
          cancelMovementRecovery();
          if (state.movementWarning !== "pose_rate_limit") {
            state.movementWarning = "pose_rate_limit"; emit("movement");
          }
          return;
        }
        const error = new SchoolClientError(value.error ?? "room_error"); state.error = error.code;
        const item = pending.get(value.requestId);
        if (item) { pending.delete(value.requestId); clearTimer(item.timer); item.reject(error); }
        if (["login_required", "room_login_required", "session_expired"].includes(error.code)) { clearIdentity(error.code); return; }
        emit("error");
        if (error.code === "stale_revision") refreshWorld(epoch, room, worldId).catch(() => {});
      }
    };
    live.onerror = () => { /* onclose owns recovery; browser hides upgrade HTTP details. */ };
    live.onclose = ({ code, reason }) => {
      if (!current()) return;
      socket = null;
      if (heartbeat !== null) clearEvery(heartbeat); heartbeat = null;
      if (openingTimer !== null) clearTimer(openingTimer); openingTimer = null;
      for (const item of pending.values()) { clearTimer(item.timer); item.reject(new SchoolClientError("connection_lost")); } pending.clear();
      cancelMovementRecovery(); state.participants = []; state.movementWarning = null;
      if (code === 1000) { state.connection = "offline"; state.error = reason === "connected in another tab" ? "connected_elsewhere" : "connection_closed"; emit("connection"); return; }
      if (code === 1008) {
        state.connection = "offline"; state.error = "session_or_membership_expired"; emit("connection");
        refreshWorld(epoch, room, worldId).then(() => scheduleReconnect()).catch((error) => {
          if (epoch === authEpoch && room === roomEpoch) { clearRoom(error.code); state.error = error.code; emit("room"); }
        });
      } else scheduleReconnect();
    };
  }
  async function openWorld(worldId) {
    assertUser(); if (!idPattern.test(worldId)) throw new SchoolClientError("world_not_found");
    clearRoom(); const epoch = authEpoch, room = roomEpoch;
    state.world = { id: worldId, name: "読み込み中" }; state.connection = "loading"; state.error = null; emit("room");
    try { await refreshWorld(epoch, room, worldId); connect(worldId, epoch, room); }
    catch (error) { if (epoch === authEpoch && room === roomEpoch) { clearRoom(); state.error = error.code ?? "world_unavailable"; emit("room"); } throw error; }
    return getState();
  }
  async function createWorld(name) {
    assertUser(); const epoch = authEpoch;
    const result = await request("/api/worlds", { method: "POST", body: { name } });
    if (epoch !== authEpoch) throw new SchoolClientError("login_cancelled");
    await loadWorlds(epoch); return openWorld(result.world.id);
  }
  async function joinWorld(code) {
    assertUser(); const clean = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (!codePattern.test(clean)) throw new SchoolClientError("invalid_join_code");
    const epoch = authEpoch, result = await request("/api/worlds/join", { method: "POST", body: { code: clean } });
    if (epoch !== authEpoch) throw new SchoolClientError("login_cancelled");
    await loadWorlds(epoch); return openWorld(result.world.id);
  }
  function leaveWorld() { clearRoom(); state.error = null; emit("room"); }
  async function updateAvatar(avatar) {
    assertUser(); const epoch = authEpoch, result = await request("/api/avatar", { method: "PATCH", body: { name: avatar.name, color: avatar.color } });
    if (epoch !== authEpoch) throw new SchoolClientError("login_cancelled");
    state.user = result.user; emit("auth"); return clone(result.user);
  }
  async function uploadAsset({ buffer, name, upAxis, units }) {
    const worldId = assertRoom(), epoch = authEpoch, room = roomEpoch;
    const result = await request(`/api/worlds/${worldId}/assets`, { method: "POST", body: buffer,
      headers: { "Content-Type": "model/stl", "X-Filename": encodeURIComponent(name), "X-Up-Axis": upAxis, "X-Units": units } });
    assertEpoch(epoch, room, worldId);
    if (!state.assets.some((asset) => asset.id === result.asset.id)) state.assets = [...state.assets, clone(result.asset)]; emit("assets");
    return clone(result.asset);
  }
  async function downloadAsset(assetId) {
    const worldId = assertRoom(), epoch = authEpoch, room = roomEpoch;
    if (!idPattern.test(assetId)) throw new SchoolClientError("asset_not_found");
    const bytes = await request(`/api/worlds/${worldId}/assets/${assetId}`, { binary: true });
    assertEpoch(epoch, room, worldId); return bytes;
  }
  function editObject(type, data) {
    const worldId = assertRoom(), epoch = authEpoch, room = roomEpoch;
    if (!["object.create", "object.update", "object.delete"].includes(type)) return Promise.reject(new SchoolClientError("invalid_command"));
    const safeData = clone(data);
    const work = editTail.catch(() => {}).then(async () => {
      assertEpoch(epoch, room, worldId);
      const wait = Math.max(0, lastEditAt + 275 - now());
      if (wait) await new Promise((resolve) => setTimer(resolve, wait));
      assertEpoch(epoch, room, worldId);
      if (!socket || socket.readyState !== 1 || state.connection !== "connected") throw new SchoolClientError("room_not_connected");
      const requestId = crypto.randomUUID();
      // Never allow callers to override command/revision/request identity.
      const message = { ...safeData, type, requestId, revision: state.revision };
      if (JSON.stringify(message).length > 16000) throw new SchoolClientError("message_too_large");
      lastEditAt = now();
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => { pending.delete(requestId); reject(new SchoolClientError("edit_timeout")); refreshWorld(epoch, room, worldId).catch(() => {}); }, 12000);
        pending.set(requestId, { resolve, reject, timer });
        try { socket.send(JSON.stringify(message)); } catch { pending.delete(requestId); clearTimer(timer); reject(new SchoolClientError("connection_lost")); }
      });
    });
    editTail = work; return work;
  }
  async function saveWorld() {
    const worldId = assertRoom(), epoch = authEpoch, room = roomEpoch;
    const result = await request(`/api/worlds/${worldId}/save`, { method: "POST", body: {} });
    assertEpoch(epoch, room, worldId); await refreshWorld(epoch, room, worldId); return result;
  }
  async function restoreWorld(snapshotId) {
    const worldId = assertRoom(), epoch = authEpoch, room = roomEpoch;
    try {
      const result = await request(`/api/worlds/${worldId}/restore`, { method: "POST", body: { snapshotId, revision: state.revision } });
      assertEpoch(epoch, room, worldId); await refreshWorld(epoch, room, worldId); return result;
    } catch (error) {
      if (epoch === authEpoch && room === roomEpoch) { state.error = error.code ?? "restore_failed"; emit("error"); await refreshWorld(epoch, room, worldId).catch(() => {}); }
      throw error;
    }
  }
  function sendPose({ position, yaw }) {
    if (!state.user || !state.world || state.connection !== "connected" || !socket || socket.readyState !== 1 || now() - lastPoseAt < 125) return false;
    if (!Array.isArray(position) || position.length !== 3 || !position.every((n) => Number.isFinite(n) && Math.abs(n) <= 25000) || position[1] < -100 || position[1] > 1200 || !Number.isFinite(yaw) || Math.abs(yaw) > Math.PI * 100) return false;
    try { socket.send(JSON.stringify({ type: "pose", position: [...position], yaw, seq: poseSeq++, restoreCommit: state.restoreCommit })); lastPoseAt = now(); return true; }
    catch { return false; }
  }
  function subscribe(listener) { listeners.add(listener); listener(readonlySnapshot({ ...state }), "state"); return () => listeners.delete(listener); }
  function destroy() { clearRoom("client_closed"); listeners.clear(); authEpoch++; csrf = nonce = null; }
  return { init, subscribe, getState, prepareGoogleLogin, login, refreshSession, logout, createWorld, joinWorld, openWorld, leaveWorld,
    updateAvatar, uploadAsset, downloadAsset, editObject, saveWorld, restoreWorld, sendPose, destroy };
}
