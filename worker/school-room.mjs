import { validatePlacement } from "../src/placement.js";
import { LIMITS, SchoolError, fail, json, publicAvatar, sha256, validId } from "./school-common.mjs";
import { all, assetPublic, authorizeRoomSession, first, getAsset, sessionByHash, worldPublic } from "./school-store.mjs";
import { readAssetModel } from "./school-assets.mjs";
import { loadCorePlacement } from "./placement-source.mjs";

const DEFAULT_POSE = Object.freeze({ position: [195, 74.4, 105], yaw: 0 });
function vector(value, minimum, maximum, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => Number.isFinite(n) && n >= minimum && n <= maximum)) fail(400, `invalid_${name}`);
  return [...value];
}
export function validatePose(value) {
  const position = vector(value.position, -25000, 25000, "pose");
  // Same geospatial world coordinates as the renderer; flight height is bounded separately.
  if (position[1] < -100 || position[1] > 1200 || !Number.isFinite(value.yaw) || Math.abs(value.yaw) > Math.PI * 100) fail(400, "invalid_pose");
  if (!Number.isSafeInteger(value.seq) || value.seq < 0) fail(400, "invalid_pose_sequence");
  return { position, yaw: value.yaw, seq: value.seq };
}
export function validateTransform(value) {
  return {
    position: vector(value.position, -25000, 25000, "position"),
    rotation: vector(value.rotation, -Math.PI * 100, Math.PI * 100, "rotation"),
    scale: vector(value.scale, 0.000001, 100, "scale"),
  };
}
function overlaps(a, b) {
  return a.min[0] < b.max[0] - 0.005 && a.max[0] > b.min[0] + 0.005 &&
    a.min[1] < b.max[1] - 0.005 && a.max[1] > b.min[1] + 0.005 &&
    a.min[2] < b.max[2] - 0.005 && a.max[2] > b.min[2] + 0.005;
}

// Plain Durable Object classes are supported by Workers. No test or auth-bypass env
// switch exists: dependencies are an optional constructor argument used only by Node tests.
export class SchoolRoom {
  constructor(ctx, env, dependencies = {}) {
    this.ctx = ctx; this.env = env;
    this.now = dependencies.now ?? (() => Date.now());
    this.makePair = dependencies.makePair ?? (() => new WebSocketPair());
    this.upgradeResponse = dependencies.upgradeResponse ?? ((client) => new Response(null, { status: 101, webSocket: client }));
    this.loadPlacement = dependencies.loadPlacement ?? (() => loadCorePlacement(env.ASSETS));
    this.sessions = new Map();
    this.assetCache = new Map();
    this.tail = Promise.resolve();
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.userId && attachment.sessionHash && socket.readyState === 1) this.sessions.set(socket, attachment);
    }
    const initialize = async () => {
      this.state = await ctx.storage.get("world-state") ?? null;
      this.restoreRecovery = await ctx.storage.get("restore-recovery") ?? null;
    };
    this.ready = ctx.blockConcurrencyWhile ? ctx.blockConcurrencyWhile(initialize) : initialize();
  }
  serial(task) {
    const result = this.tail.then(() => this.ready).then(task);
    this.tail = result.catch(() => {});
    return result;
  }
  async caller(request, teacher = false) {
    // Only index.mjs can reach this DO: it creates this header, and never forwards
    // a user-supplied header. The actual session/membership is rechecked here.
    let context;
    try { context = JSON.parse(request.headers.get("X-School-Context")); } catch { fail(401, "login_required"); }
    if (!context || !validId(context.worldId) || typeof context.sessionHash !== "string" || !/^[a-f0-9]{64}$/.test(context.sessionHash)) fail(401, "login_required");
    const authorized = await authorizeRoomSession(this.env.DB, context.worldId, context.sessionHash, Math.floor(this.now() / 1000), teacher);
    if (this.state && this.state.worldId !== context.worldId) fail(403, "room_mismatch");
    if (!this.state) {
      const initial = { worldId: context.worldId, revision: 0, objects: [], recent: [] };
      // A room can hibernate before any edit; its identity must survive that too.
      await this.ctx.storage.put("world-state", initial);
      this.state = initial;
    }
    return { ...authorized, context };
  }
  fetch(request) { return this.serial(() => this.handleFetch(request)); }
  async handleFetch(request) {
    try {
      await this.recoverRestore();
      const path = new URL(request.url).pathname;
      const caller = await this.caller(request, ["/save", "/restore"].includes(path));
      if (path === "/socket" && request.method === "GET") {
        if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") fail(426, "websocket_required");
        return await this.connect(caller);
      }
      if (path === "/state" && request.method === "GET") return json(await this.snapshot(caller.world, caller.session));
      if (path === "/save" && request.method === "POST") return json(await this.save(caller));
      if (path === "/restore" && request.method === "POST") {
        const data = await request.json();
        return json(await this.restore(caller, data));
      }
      if (path === "/disconnect" && request.method === "POST") {
        for (const [socket, attachment] of this.sessions) {
          if (attachment.sessionHash === caller.context.sessionHash) this.remove(socket, 1000, "signed out");
        }
        this.broadcastPresence();
        return json({ ok: true });
      }
      fail(404, "not_found");
    } catch (error) {
      return json({ error: error instanceof SchoolError ? error.code : "internal_error" }, error instanceof SchoolError ? error.status : 500);
    }
  }
  async connect(caller) {
    // Capacity counts identities, not tabs. Queue serialization makes simultaneous
    // reconnects/capacity checks race-safe, including the old close event.
    await this.pruneExpired();
    for (const [socket, attachment] of this.sessions) if (attachment.userId === caller.session.id) this.remove(socket, 1000, "connected in another tab");
    if (this.sessions.size >= LIMITS.participants) fail(409, "room_full");
    const pair = this.makePair(), [client, server] = Object.values(pair);
    const savedPose = caller.membership.pose_json ? JSON.parse(caller.membership.pose_json) : DEFAULT_POSE;
    const attachment = { userId: caller.session.id, sessionHash: caller.context.sessionHash,
      expiresAt: caller.session.expires_at, avatar: publicAvatar(caller.session),
      pose: { position: [...savedPose.position], yaw: savedPose.yaw }, lastSeq: -1,
      lastPoseAt: -1e15, lastEditAt: -1e15, lastPingAt: -1e15, lastSeenAt: this.now(), rateWindowAt: this.now(), rateCount: 0 };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.sessions.set(server, attachment);
    try { server.send(JSON.stringify({ type: "state", ...await this.snapshot(caller.world, caller.session) })); }
    catch (error) { this.remove(server, 1011, "initial state unavailable"); throw error; }
    this.broadcastPresence();
    await this.scheduleAlarm();
    return this.upgradeResponse(client);
  }
  participants() {
    return [...this.sessions.values()].map((attachment) => ({ ...attachment.avatar, position: [...attachment.pose.position], yaw: attachment.pose.yaw }));
  }
  async snapshot(world, session) {
    const assets = await all(this.env.DB, "SELECT * FROM school_assets WHERE world_id=? AND status='ready' ORDER BY created_at,id", world.id);
    const saved = await all(this.env.DB, "SELECT id,revision,created_at FROM school_snapshots WHERE world_id=? ORDER BY created_at DESC,id DESC LIMIT 20", world.id);
    return { revision: this.state.revision, world: worldPublic(world, session.id === world.teacher_id && session.role === "teacher"),
      participants: this.participants(), objects: this.state.objects, assets: assets.map(assetPublic),
      snapshots: session.id === world.teacher_id && session.role === "teacher" ? saved.map((row) => ({ id: row.id, revision: row.revision, createdAt: row.created_at })) : [] };
  }
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const socket of this.sessions.keys()) {
      try { socket.send(data); }
      catch { this.remove(socket, 1011, "connection lost"); }
    }
  }
  broadcastPresence() { this.broadcast({ type: "participants", participants: this.participants(), revision: this.state?.revision ?? 0 }); }
  remove(socket, code, reason) {
    this.sessions.delete(socket);
    try { socket.close(code, reason); } catch { /* already closed */ }
  }
  async pruneExpired() {
    const now = Math.floor(this.now() / 1000);
    for (const [socket, attachment] of this.sessions) {
      const session = attachment.expiresAt > now && this.now() - attachment.lastSeenAt <= 60000 && await sessionByHash(this.env.DB, attachment.sessionHash, now);
      if (!session || !await first(this.env.DB, "SELECT user_id FROM school_members WHERE world_id=? AND user_id=?", this.state.worldId, attachment.userId)) this.remove(socket, 1008, "session expired");
    }
  }
  async scheduleAlarm() {
    if (!this.ctx.storage.setAlarm || !this.sessions.size) return;
    const earliest = Math.min(...[...this.sessions.values()].map((attachment) => Math.min(attachment.expiresAt * 1000, attachment.lastSeenAt + 60001)));
    await this.ctx.storage.setAlarm(Math.max(this.now() + 1000, earliest));
  }
  alarm() { return this.serial(async () => { await this.recoverRestore(); await this.pruneExpired(); this.broadcastPresence(); await this.scheduleAlarm(); }); }
  webSocketClose(socket) { return this.serial(() => { if (this.sessions.has(socket)) { this.remove(socket, 1000, "disconnected"); this.broadcastPresence(); } }); }
  webSocketError(socket) { return this.serial(() => { this.remove(socket, 1011, "connection error"); this.broadcastPresence(); }); }
  webSocketMessage(socket, data) {
    return this.serial(async () => {
      let value;
      try {
        const attachment = this.sessions.get(socket);
        if (!attachment) fail(401, "login_required");
        if (this.now() - attachment.rateWindowAt >= 1000) { attachment.rateWindowAt = this.now(); attachment.rateCount = 0; }
        if (++attachment.rateCount > 20) {
          this.remove(socket, 1008, "message rate limit"); this.broadcastPresence(); fail(429, "message_rate_limit");
        }
        socket.serializeAttachment(attachment);
        if (typeof data !== "string" || new TextEncoder().encode(data).length > LIMITS.messageBytes) fail(413, "message_too_large");
        try { value = JSON.parse(data); } catch { fail(400, "invalid_message"); }
        if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_message");
        await this.recoverRestore();
        const now = Math.floor(this.now() / 1000);
        let authorization;
        try {
          if (attachment.expiresAt <= now) fail(401, "room_login_required");
          authorization = await authorizeRoomSession(this.env.DB, this.state.worldId, attachment.sessionHash, now);
        } catch (error) {
          if (error instanceof SchoolError && error.status === 401) { this.remove(socket, 1008, "session expired"); this.broadcastPresence(); }
          throw error;
        }
        const { session, world } = authorization;
        attachment.avatar = publicAvatar(session);
        if (value.type === "ping") {
          const pingAt = this.now();
          if (!Number.isFinite(pingAt)) fail(429, "ping_rate_limit");
          // Heartbeats are independent of the 8Hz pose stream. lastSeenAt is
          // shared liveness, not the ping budget: a pose a few milliseconds ago
          // must not make the normal 20-second heartbeat fail. Older attached
          // sockets have no lastPingAt; malformed/future values fail closed for
          // one interval, then recover from a finite clamped timestamp.
          const previousPing = attachment.lastPingAt === undefined ? -1e15 :
            Number.isFinite(attachment.lastPingAt) ? Math.max(-1e15, Math.min(pingAt, attachment.lastPingAt)) : pingAt;
          attachment.lastPingAt = previousPing;
          if (pingAt - previousPing < 100) {
            socket.serializeAttachment(attachment); fail(429, "ping_rate_limit");
          }
          attachment.lastPingAt = pingAt; attachment.lastSeenAt = pingAt; socket.serializeAttachment(attachment);
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (value.type === "pose") {
          const pose = validatePose(value);
          if (pose.seq <= attachment.lastSeq) fail(409, "stale_pose");
          if (this.now() - attachment.lastPoseAt < 100) fail(429, "pose_rate_limit");
          attachment.pose = { position: pose.position, yaw: pose.yaw };
          attachment.lastSeq = pose.seq; attachment.lastPoseAt = this.now(); attachment.lastSeenAt = this.now();
          socket.serializeAttachment(attachment);
          this.broadcast({ type: "pose", participant: { ...attachment.avatar, ...attachment.pose }, revision: this.state.revision });
          return;
        }
        if (!["object.create", "object.update", "object.delete"].includes(value.type) || !validId(value.requestId)) fail(400, "invalid_command");
        const fingerprint = await sha256(JSON.stringify(value));
        const previous = this.state.recent.find((entry) => entry.userId === session.id && entry.requestId === value.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail(409, "request_id_reused");
          socket.send(JSON.stringify({ ...previous.ack, revision: this.state.revision }));
          return;
        }
        if (!Number.isSafeInteger(value.revision) || value.revision !== this.state.revision) fail(409, "stale_revision");
        if (this.now() - attachment.lastEditAt < 250) fail(429, "edit_rate_limit");
        attachment.lastEditAt = this.now(); attachment.lastSeenAt = this.now(); socket.serializeAttachment(attachment);
        const before = this.state;
        let ack;
        try {
          const result = await this.applyEdit(value, session, world);
          ack = { type: "ack", requestId: value.requestId, revision: this.state.revision, id: result.id };
          this.state.recent = [...this.state.recent, { userId: session.id, requestId: value.requestId, fingerprint, ack }].slice(-128);
          await this.ctx.storage.put("world-state", this.state);
        } catch (error) { this.state = before; throw error; }
        this.broadcast({ type: "objects", revision: this.state.revision, objects: this.state.objects });
        socket.send(JSON.stringify(ack));
      } catch (error) {
        try { socket.send(JSON.stringify({ type: "error", error: error instanceof SchoolError ? error.code : "internal_error",
          ...(validId(value?.requestId) ? { requestId: value.requestId } : {}), revision: this.state?.revision ?? 0 })); } catch { /* closed */ }
      }
    });
  }
  async model(asset) {
    if (this.assetCache.has(asset.id)) {
      const model = this.assetCache.get(asset.id); this.assetCache.delete(asset.id); this.assetCache.set(asset.id, model); return model;
    }
    const model = await readAssetModel(this.env, asset);
    this.assetCache.set(asset.id, model);
    while (this.assetCache.size > 8) this.assetCache.delete(this.assetCache.keys().next().value);
    return model;
  }
  async applyEdit(value, session, world) {
    const current = this.state.objects.find((object) => object.id === value.id);
    if (value.type !== "object.create") {
      if (!current) fail(404, "object_not_found");
      // Even the teacher must not silently edit a student's own work. Teacher
      // controls are whole-world checkpoint/restore, not ownership impersonation.
      if (current.ownerId !== session.id) fail(403, "object_owner_required");
    }
    if (value.type === "object.delete") {
      this.state = { ...this.state, revision: this.state.revision + 1, objects: this.state.objects.filter((object) => object.id !== current.id) };
      return current;
    }
    if (value.type === "object.create" && this.state.objects.length >= LIMITS.objects) fail(409, "world_object_limit");
    if (value.type === "object.create" && value.id !== undefined && (!validId(value.id) || current)) fail(409, "object_id_unavailable");
    const assetId = value.type === "object.create" ? value.assetId : current.assetId;
    if (value.assetId !== undefined && value.assetId !== assetId) fail(400, "asset_change_not_allowed");
    const asset = await getAsset(this.env.DB, world.id, assetId);
    if (asset.owner_id !== session.id) fail(403, "asset_owner_required");
    if (this.state.objects.reduce((sum, object) => sum + (object.id === current?.id ? 0 : object.triangles), asset.triangles) > LIMITS.worldTriangles) fail(409, "world_triangle_limit");
    const transform = validateTransform(value), model = await this.model(asset);
    const placement = validatePlacement({ positions: model.positions, ...transform }, await this.loadPlacement());
    if (!placement.valid) fail(409, "invalid_placement", placement.error);
    if (placement.bounds.max.some((n, axis) => n - placement.bounds.min[axis] > LIMITS.objectMeters)) fail(409, "object_size_limit");
    if (this.state.objects.some((object) => object.id !== current?.id && overlaps(placement.bounds, object.bounds))) fail(409, "object_overlap");
    const object = { id: current?.id ?? value.id ?? crypto.randomUUID(), ownerId: session.id, assetId,
      name: asset.name, position: [...placement.position], rotation: transform.rotation, scale: transform.scale,
      bounds: placement.bounds, triangles: asset.triangles };
    this.state = { ...this.state, revision: this.state.revision + 1,
      objects: [...this.state.objects.filter((entry) => entry.id !== object.id), object] };
    return object;
  }
  async save(caller) {
    const now = Math.floor(this.now() / 1000), id = crypto.randomUUID();
    await this.pruneExpired();
    const members = await all(this.env.DB, "SELECT user_id,pose_json FROM school_members WHERE world_id=?", this.state.worldId);
    const poses = Object.fromEntries(members.filter((member) => member.pose_json).map((member) => [member.user_id, JSON.parse(member.pose_json)]));
    for (const attachment of this.sessions.values()) poses[attachment.userId] = attachment.pose;
    const saved = { schema: 1, worldId: this.state.worldId, revision: this.state.revision, objects: this.state.objects, poses };
    const statements = [this.env.DB.prepare("INSERT INTO school_snapshots(id,world_id,teacher_id,revision,state_json,created_at) VALUES(?,?,?,?,?,?)")
      .bind(id, this.state.worldId, caller.session.id, this.state.revision, JSON.stringify(saved), now)];
    for (const [userId, pose] of Object.entries(poses)) statements.push(this.env.DB.prepare("UPDATE school_members SET pose_json=? WHERE world_id=? AND user_id=?").bind(JSON.stringify(pose), this.state.worldId, userId));
    statements.push(this.env.DB.prepare("DELETE FROM school_snapshots WHERE world_id=? AND id NOT IN (SELECT id FROM school_snapshots WHERE world_id=? ORDER BY created_at DESC,id DESC LIMIT 20)").bind(this.state.worldId, this.state.worldId));
    await this.env.DB.batch(statements);
    return { id, revision: this.state.revision, createdAt: now };
  }
  async restore(caller, value) {
    await this.recoverRestore();
    if (!validId(value.snapshotId) || !Number.isSafeInteger(value.revision) || value.revision !== this.state.revision) fail(409, "stale_revision");
    const row = await first(this.env.DB, "SELECT * FROM school_snapshots WHERE id=? AND world_id=?", value.snapshotId, this.state.worldId);
    if (!row) fail(404, "snapshot_not_found");
    const saved = JSON.parse(row.state_json);
    if (saved.schema !== 1 || saved.worldId !== this.state.worldId || !Array.isArray(saved.objects) || saved.objects.length > LIMITS.objects) fail(503, "snapshot_invalid");
    // Snapshot content only originates in this room's server, but confirm private
    // assets still exist and belong to the recorded owners before changing state.
    for (const object of saved.objects) {
      const asset = await getAsset(this.env.DB, this.state.worldId, object.assetId);
      if (asset.owner_id !== object.ownerId) fail(503, "snapshot_asset_invalid");
    }
    const commitId = crypto.randomUUID();
    const next = { ...this.state, revision: this.state.revision + 1, objects: saved.objects, recent: [], restoreCommit: commitId };
    const members = await all(this.env.DB, "SELECT user_id,pose_json FROM school_members WHERE world_id=?", this.state.worldId);
    const intent = { worldId: this.state.worldId, revision: next.revision, commitId,
      before: Object.fromEntries(members.map((member) => [member.user_id, member.pose_json])),
      after: Object.fromEntries(Object.entries(saved.poses).map(([userId, pose]) => [userId, JSON.stringify(pose)])),
      poses: saved.poses };
    // D1 and DO storage cannot share a transaction. Durable world-state is the
    // authoritative commit point; journal first, D1 mirror second, DO commit last.
    // A failed/interrupted attempt is rolled back or completed from the durable
    // DO commit marker before subsequent fetch/message/save uses its pose mirror.
    try { await this.ctx.storage.put("restore-recovery", intent); }
    catch (error) {
      // A rejected journal write may also have an uncertain outcome. Resolve its
      // actual durable presence before another edit can advance the room revision.
      try {
        this.restoreRecovery = await this.ctx.storage.get("restore-recovery") ?? null;
        await this.recoverRestore();
      } catch {
        this.restoreRecovery = intent;
        await this.armRestoreRecovery();
        fail(503, "restore_recovery_pending");
      }
      throw error;
    }
    this.restoreRecovery = intent;
    try {
      await this.writePoseMirror(intent.worldId, intent.after);
      await this.ctx.storage.put("world-state", next);
      this.state = next;
    } catch (error) {
      await this.recoverRestore();
      // A storage error can have an uncertain outcome. Recovery reads the actual
      // durable revision, never assumes that a rejected write did/did not commit.
      if (this.state.restoreCommit !== commitId) throw error;
      return { revision: this.state.revision, snapshotId: row.id };
    }
    await this.notifyRestoredState(saved.poses);
    try {
      await this.ctx.storage.put("restore-recovery", null);
      this.restoreRecovery = null;
    } catch {
      await this.armRestoreRecovery();
      fail(503, "restore_recovery_pending");
    }
    return { revision: this.state.revision, snapshotId: row.id };
  }
  async writePoseMirror(worldId, poses) {
    const statements = [this.env.DB.prepare("UPDATE school_members SET pose_json=NULL WHERE world_id=?").bind(worldId)];
    for (const [userId, pose] of Object.entries(poses)) if (pose !== null) statements.push(this.env.DB.prepare("UPDATE school_members SET pose_json=? WHERE world_id=? AND user_id=?").bind(pose, worldId, userId));
    await this.env.DB.batch(statements);
  }
  async armRestoreRecovery() {
    // Recovery must run even when all browsers have left the room. If scheduling
    // fails, the durable journal still blocks/retries the next operation; alarms
    // also throw on recovery failure so the runtime applies its retry policy.
    try { if (this.ctx.storage.setAlarm) await this.ctx.storage.setAlarm(this.now() + 1000); } catch { /* next operation retries the durable journal */ }
  }
  async recoverRestore() {
    const intent = this.restoreRecovery;
    if (!intent) return;
    try {
      const authoritative = await this.ctx.storage.get("world-state");
      if (!authoritative || authoritative.worldId !== intent.worldId) fail(503, "restore_recovery_pending");
      this.state = authoritative;
      // A unique commit marker avoids treating an unrelated edit with the same
      // revision as a restore if an earlier journal write had an uncertain result.
      const committed = typeof intent.commitId === "string" && authoritative.restoreCommit === intent.commitId;
      await this.writePoseMirror(intent.worldId, committed ? intent.after : intent.before);
      if (committed) await this.notifyRestoredState(intent.poses);
      await this.ctx.storage.put("restore-recovery", null);
      this.restoreRecovery = null;
    } catch {
      await this.armRestoreRecovery();
      fail(503, "restore_recovery_pending");
    }
  }
  async notifyRestoredState(poses) {
    for (const [socket, attachment] of this.sessions) {
      try {
        const now = Math.floor(this.now() / 1000);
        if (attachment.expiresAt <= now || this.now() - attachment.lastSeenAt > 60000) fail(401, "room_login_required");
        const authorized = await authorizeRoomSession(this.env.DB, this.state.worldId, attachment.sessionHash, now);
        if (poses[attachment.userId]) attachment.pose = poses[attachment.userId];
        socket.serializeAttachment(attachment);
        socket.send(JSON.stringify({ type: "state", ...await this.snapshot(authorized.world, authorized.session) }));
      } catch (error) {
        this.remove(socket, error instanceof SchoolError && error.status === 401 ? 1008 : 1011, "restored state unavailable");
      }
    }
    // A failed recipient must not stop healthy recipients or remain visible as a
    // ghost in their earlier per-recipient snapshot. Reconnecting gets the commit.
    this.broadcastPresence();
  }
}
