import { DurableObject } from "cloudflare:workers";
import { DEFAULT_TEMPLATE, renderTemplate, sendSms, smsBytes, smsMode } from "./sms.js";

const MAX_AMOUNT = 100_000_000; // 1억 원
const MAX_IMAGE_BYTES = 1_500_000; // base64 문자열 기준
const BID_COOLDOWN_MS = 1000;
const MAX_PHOTOS = 30; // 물품당 상세사진 최대 장수

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const err = (status, message, extra = {}) => json({ error: message, ...extra }, status);

const maskEmp = (e) => (e ? String(e).slice(0, 2) + "**" + String(e).slice(4) : "");
const maskPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(0, 3) + "-****-" + d.slice(-4) : "";
};
const fmtPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  if (d.length === 10) return d.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
  return d;
};
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

export class Auction extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
    if (typeof WebSocketRequestResponsePair !== "undefined" && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  /* ---------------- DB ---------------- */
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  first(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  run(q, ...a) { this.sql.exec(q, ...a); }

  migrate() {
    this.run(`CREATE TABLE IF NOT EXISTS items(
      id TEXT PRIMARY KEY, no INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '',
      donor TEXT DEFAULT '', start_price INTEGER NOT NULL, step INTEGER NOT NULL, end_at INTEGER NOT NULL,
      img_ver INTEGER DEFAULT 0, created_at INTEGER, settled_at INTEGER, winner_bid_id INTEGER)`);
    this.run(`CREATE TABLE IF NOT EXISTS images(item_id TEXT PRIMARY KEY, mime TEXT, b64 TEXT)`);
    this.run(`CREATE TABLE IF NOT EXISTS bids(
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, emp TEXT NOT NULL, phone TEXT,
      pid TEXT NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL)`);
    this.run(`CREATE INDEX IF NOT EXISTS bids_item ON bids(item_id, amount DESC, at ASC)`);
    this.run(`CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY, emp TEXT NOT NULL, phone TEXT, pid TEXT NOT NULL, created_at INTEGER, last_bid_at INTEGER DEFAULT 0)`);
    this.run(`CREATE TABLE IF NOT EXISTS sms_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, to_phone TEXT, text TEXT, bytes INTEGER,
      mode TEXT, status TEXT, detail TEXT, kind TEXT, at INTEGER)`);
    this.run(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
    this.run(`CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, ord INTEGER NOT NULL, mime TEXT, b64 TEXT)`);
    this.run(`CREATE INDEX IF NOT EXISTS photos_item ON photos(item_id, ord)`);
    this.addColumn("items", "photo_ver", "INTEGER DEFAULT 0");
    this.addColumn("sessions", "is_admin", "INTEGER DEFAULT 0");
    this.addColumn("items", "is_sample", "INTEGER DEFAULT 0");
    if (!this.getSetting("pid_salt")) this.setSetting("pid_salt", randHex(16));
  }
  addColumn(table, col, type) {
    if (!this.all(`PRAGMA table_info(${table})`).some((c) => c.name === col)) this.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  // ADMIN_USERS 비밀값: "사번:휴대폰,사번:휴대폰,..."
  adminUsers() {
    const m = new Map();
    for (const part of String(this.env.ADMIN_USERS || "").split(/[,\n;]+/)) {
      const [e, ph] = part.split(":").map((x) => (x || "").replace(/\D/g, ""));
      if (/^\d{6}$/.test(e) && ph) (m.get(e) || m.set(e, new Set()).get(e)).add(ph);
    }
    return m;
  }
  isAdminPair(emp, phone) { const s = this.adminUsers().get(emp); return !!(s && s.has(phone)); }
  getSetting(k) { const r = this.first(`SELECT value FROM settings WHERE key=?`, k); return r ? r.value : null; }
  setSetting(k, v) { this.run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, String(v)); }

  eventName() { return this.env.EVENT_NAME || "연말 나눔 경매"; }
  template() { return this.getSetting("sms_template") || DEFAULT_TEMPLATE; }
  antiSnipeMs() { return Math.max(0, int(this.env.ANTI_SNIPE_SECONDS || 0) || 0) * 1000; }

  topBid(itemId, endAt) {
    return this.first(`SELECT * FROM bids WHERE item_id=? AND at<=? ORDER BY amount DESC, at ASC LIMIT 1`, itemId, endAt);
  }

  summary(it, now = Date.now()) {
    const top = this.topBid(it.id, it.end_at);
    const cnt = this.first(`SELECT COUNT(*) AS c FROM bids WHERE item_id=? AND at<=?`, it.id, it.end_at).c;
    const closed = now >= it.end_at;
    return {
      id: it.id, no: it.no, name: it.name, sample: !!it.is_sample, description: it.description, donor: it.donor,
      start: it.start_price, step: it.step, endAt: it.end_at, imgVer: it.img_ver || 0, photoVer: it.photo_ver || 0,
      bidCount: cnt,
      top: top ? { amount: top.amount, emp: maskEmp(top.emp), pid: top.pid, at: top.at } : null,
      minNext: top ? top.amount + it.step : it.start_price,
      status: closed ? (top ? "sold" : "unsold") : "live",
    };
  }
  items() { return this.all(`SELECT * FROM items ORDER BY no ASC`); }
  state() {
    const now = Date.now();
    return { now, eventName: this.eventName(), items: this.items().map((it) => this.summary(it, now)) };
  }

  /* ---------------- realtime ---------------- */
  broadcast(extra = {}) {
    this.sendAll(JSON.stringify({ type: "state", ...this.state(), ...extra }));
  }
  // 입찰 한 건은 바뀐 물품 하나와 새 입찰만 보냄 (전체 목록보다 훨씬 작음)
  broadcastBid(itemRow, bid) {
    this.sendAll(JSON.stringify({ type: "item", now: Date.now(), item: this.summary(itemRow), bid }));
  }
  sendAll(msg) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch (e) { /* closed */ }
    }
  }
  webSocketMessage(ws, msg) {
    if (msg === "ping") ws.send("pong");
  }
  webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch (e) {}
  }
  webSocketError() {}

  /* ---------------- alarms / settlement ---------------- */
  async scheduleAlarm() {
    const r = this.first(`SELECT MIN(end_at) AS t FROM items WHERE settled_at IS NULL`);
    if (r && r.t != null) await this.ctx.storage.setAlarm(Math.max(r.t, Date.now() + 50));
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    await this.settleDue();
    await this.scheduleAlarm();
  }
  async settleDue() {
    const now = Date.now();
    const due = this.all(`SELECT * FROM items WHERE settled_at IS NULL AND end_at<=?`, now);
    if (!due.length) return;
    const toNotify = [];
    for (const it of due) {
      const top = this.topBid(it.id, it.end_at);
      this.run(`UPDATE items SET settled_at=?, winner_bid_id=? WHERE id=?`, now, top ? top.id : null, it.id);
      if (top) toNotify.push({ it, top });
    }
    this.broadcast({ change: { type: "closed", itemIds: due.map((d) => d.id) } });
    for (const { it, top } of toNotify) await this.notifyWinner(it, top, "auto");
  }
  async notifyWinner(it, top, kind) {
    const text = renderTemplate(this.template(), { event: this.eventName(), no: it.no, name: it.name, amount: top.amount, emp: top.emp });
    const to = top.phone || "";
    if (!to) {
      this.run(`INSERT INTO sms_log(item_id,to_phone,text,bytes,mode,status,detail,kind,at) VALUES(?,?,?,?,?,?,?,?,?)`,
        it.id, "", text, smsBytes(text), smsMode(this.env), "failed", "연락처가 삭제되어 보낼 수 없습니다.", kind, Date.now());
      return;
    }
    const r = it.is_sample ? { mode: "sample", status: "preview", detail: "샘플 물품 — 실제로 발송하지 않았습니다." } : await sendSms(this.env, { to, text });
    this.run(`INSERT INTO sms_log(item_id,to_phone,text,bytes,mode,status,detail,kind,at) VALUES(?,?,?,?,?,?,?,?,?)`,
      it.id, to, text, smsBytes(text), r.mode, r.status, r.detail, kind, Date.now());
  }

  /* ---------------- HTTP ---------------- */
  async fetch(request) {
    try {
      return await this.route(request);
    } catch (e) {
      console.error(e);
      return err(500, "서버 오류가 발생했습니다.");
    }
  }

  session(request) {
    const h = request.headers.get("authorization") || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!/^[0-9a-f]{48}$/.test(tok)) return null;
    return this.first(`SELECT * FROM sessions WHERE token=?`, tok);
  }
  // 로그인할 때 관리자 명단과 맞았고, 지금도 명단에 있으면 관리자
  sessionIsAdmin(s) {
    return !!(s && s.is_admin === 1 && this.isAdminPair(s.emp, s.phone || ""));
  }

  async route(request) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "");
    const m = request.method;

    // lazy settlement in case an alarm is late
    if (this.first(`SELECT 1 AS x FROM items WHERE settled_at IS NULL AND end_at<=? LIMIT 1`, Date.now())) {
      await this.settleDue();
      await this.scheduleAlarm();
    }

    if (p === "/api/ws") {
      if (request.headers.get("upgrade") !== "websocket") return err(426, "websocket only");
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "state", ...this.state() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/api/state" && m === "GET") return json(this.state());
    if (p === "/api/login" && m === "POST") return this.login(request);
    if (p === "/api/me" && m === "GET") {
      const s = this.session(request);
      return s ? json({ emp: s.emp, phone: maskPhone(s.phone), pid: s.pid, isAdmin: this.sessionIsAdmin(s) }) : err(401, "로그인이 필요합니다.");
    }
    if (p === "/api/bid" && m === "POST") return this.bid(request);
    let mm;
    if ((mm = p.match(/^\/api\/items\/([\w-]+)$/)) && m === "GET") return this.itemDetail(mm[1]);
    if ((mm = p.match(/^\/api\/img\/([\w-]+)$/)) && m === "GET") return this.image(mm[1]);
    if ((mm = p.match(/^\/api\/photo\/(\d+)$/)) && m === "GET") return this.photo(int(mm[1]));

    if (p.startsWith("/api/admin/")) {
      const s = this.session(request);
      if (!s) return err(401, "로그인이 필요합니다.");
      if (!this.sessionIsAdmin(s)) return err(403, "관리자로 지정된 계정이 아닙니다.");
      return this.admin(request, p.slice("/api/admin".length), m, url);
    }
    return err(404, "not found");
  }

  async login(request) {
    const b = await request.json().catch(() => ({}));
    const emp = String(b.emp || "").trim();
    const phone = String(b.phone || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(emp)) return err(400, "사번 6자리를 정확히 입력해 주세요.");
    if (!/^01[016789]\d{7,8}$/.test(phone)) return err(400, "휴대폰 번호를 정확히 입력해 주세요.");
    if (b.agree !== true) return err(400, "개인정보 수집에 동의해 주세요.");
    const token = randHex(24);
    const pid = (await sha256Hex(this.getSetting("pid_salt") + ":" + emp)).slice(0, 16);
    const isAdmin = this.isAdminPair(emp, phone);
    this.run(`INSERT INTO sessions(token,emp,phone,pid,created_at,is_admin) VALUES(?,?,?,?,?,?)`, token, emp, phone, pid, Date.now(), isAdmin ? 1 : 0);
    return json({ token, emp, pid, phone: maskPhone(phone), isAdmin });
  }

  async bid(request) {
    const s = this.session(request);
    if (!s) return err(401, "로그인이 필요합니다.");
    const b = await request.json().catch(() => ({}));
    const amount = int(b.amount);
    // ---- 이 아래부터 await 없이 동기 처리: 동시에 들어온 입찰도 한 건씩 순서대로 판정됩니다 ----
    const now = Date.now();
    const it = this.first(`SELECT * FROM items WHERE id=?`, String(b.itemId || ""));
    if (!it) return err(404, "물품을 찾을 수 없습니다.");
    if (now >= it.end_at) return err(409, "경매가 종료되었습니다.", { code: "closed" });
    if (now - (s.last_bid_at || 0) < BID_COOLDOWN_MS) return err(429, "잠시 후 다시 시도해 주세요.");
    const top = this.topBid(it.id, it.end_at);
    const min = top ? top.amount + it.step : it.start_price;
    if (!Number.isInteger(amount) || amount < min) return err(409, `${min.toLocaleString("ko-KR")}원 이상 입찰해 주세요.`, { code: "low", minNext: min });
    if (amount > MAX_AMOUNT) return err(400, "입찰 가능한 최대 금액을 넘었습니다.");
    if (top && top.pid === s.pid) return err(409, "이미 최고가 입찰자입니다.", { code: "already_top" });
    this.run(`INSERT INTO bids(item_id,emp,phone,pid,amount,at) VALUES(?,?,?,?,?,?)`, it.id, s.emp, s.phone, s.pid, amount, now);
    this.run(`UPDATE sessions SET last_bid_at=? WHERE token=?`, now, s.token);
    let extended = false;
    const snipe = this.antiSnipeMs();
    if (snipe && it.end_at - now < snipe) {
      this.run(`UPDATE items SET end_at=? WHERE id=?`, now + snipe, it.id);
      extended = true;
    }
    if (extended) await this.scheduleAlarm();
    if (extended) this.broadcast({ change: { type: "extended", itemId: it.id } });
    else this.broadcastBid(it, { emp: maskEmp(s.emp), pid: s.pid, amount, at: now });
    return json({ ok: true, amount, extended });
  }

  itemDetail(id) {
    const it = this.first(`SELECT * FROM items WHERE id=?`, id);
    if (!it) return err(404, "물품을 찾을 수 없습니다.");
    const bids = this.all(`SELECT emp,pid,amount,at FROM bids WHERE item_id=? AND at<=? ORDER BY amount DESC, at ASC LIMIT 200`, id, it.end_at)
      .map((x) => ({ emp: maskEmp(x.emp), pid: x.pid, amount: x.amount, at: x.at }));
    const photos = this.all(`SELECT id FROM photos WHERE item_id=? ORDER BY ord, id`, id).map((r) => r.id);
    return json({ now: Date.now(), item: this.summary(it), bids, photos });
  }

  photo(id) {
    const r = this.first(`SELECT mime,b64 FROM photos WHERE id=?`, id);
    if (!r) return new Response("not found", { status: 404 });
    const bin = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { "content-type": r.mime, "cache-control": "public, max-age=31536000, immutable" } });
  }
  bumpPhotos(itemId) { this.run(`UPDATE items SET photo_ver=COALESCE(photo_ver,0)+1 WHERE id=?`, itemId); }

  image(id) {
    const r = this.first(`SELECT mime,b64 FROM images WHERE item_id=?`, id);
    if (!r) return new Response("not found", { status: 404 });
    const bin = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { "content-type": r.mime, "cache-control": "public, max-age=31536000, immutable" } });
  }

  /* ---------------- admin ---------------- */
  readItemBody(b, partial = false) {
    const out = {};
    const need = (k) => !partial || b[k] !== undefined;
    if (need("no")) { out.no = int(b.no); if (!(out.no > 0)) throw new Error("번호를 확인해 주세요."); }
    if (need("name")) { out.name = String(b.name || "").trim().slice(0, 100); if (!out.name) throw new Error("물품명을 입력해 주세요."); }
    if (need("description")) out.description = String(b.description || "").slice(0, 3000);
    if (need("donor")) out.donor = String(b.donor || "").trim().slice(0, 60);
    if (need("start")) { out.start_price = int(b.start); if (!(out.start_price >= 0)) throw new Error("시작가를 확인해 주세요."); }
    if (need("step")) { out.step = int(b.step); if (!(out.step > 0)) throw new Error("입찰 단위를 확인해 주세요."); }
    if (need("endAt")) { out.end_at = int(b.endAt); if (!(out.end_at > 0)) throw new Error("종료 시각을 확인해 주세요."); }
    return out;
  }

  adminOverview() {
    const now = Date.now();
    const items = this.items().map((it) => {
      const s = this.summary(it, now);
      const top = this.topBid(it.id, it.end_at);
      return { ...s, settledAt: it.settled_at,
        winner: s.status === "sold" && top ? { emp: top.emp, phone: fmtPhone(top.phone), amount: top.amount, at: top.at } : null,
        leader: top ? { emp: top.emp, phone: fmtPhone(top.phone), amount: top.amount } : null };
    });
    const sms = this.all(`SELECT * FROM sms_log ORDER BY id DESC LIMIT 200`).map((r) => ({ ...r, to_phone: fmtPhone(r.to_phone) }));
    const stats = this.first(`SELECT COUNT(*) AS bids, COUNT(DISTINCT pid) AS bidders FROM bids`);
    const sessions = this.first(`SELECT COUNT(DISTINCT emp) AS c FROM sessions`).c;
    return { now, eventName: this.eventName(), smsMode: smsMode(this.env), template: this.template(), defaultTemplate: DEFAULT_TEMPLATE,
      antiSnipeSeconds: this.antiSnipeMs() / 1000, items, sms, stats: { ...stats, participants: sessions } };
  }

  async admin(request, p, m, url) {
    const body = async () => request.json().catch(() => ({}));
    let mm;
    try {
      if (p === "/overview" && m === "GET") return json(this.adminOverview());

      if (p === "/items" && m === "POST") {
        const d = this.readItemBody(await body());
        if (this.first(`SELECT 1 AS x FROM items WHERE no=?`, d.no)) return err(409, `No.${d.no} 은(는) 이미 있습니다.`);
        const id = "i" + Date.now().toString(36) + randHex(2);
        this.run(`INSERT INTO items(id,no,name,description,donor,start_price,step,end_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          id, d.no, d.name, d.description, d.donor, d.start_price, d.step, d.end_at, Date.now());
        await this.afterItemChange();
        return json({ ok: true, id });
      }
      if ((mm = p.match(/^\/items\/([\w-]+)$/))) {
        const id = mm[1];
        const it = this.first(`SELECT * FROM items WHERE id=?`, id);
        if (!it) return err(404, "물품을 찾을 수 없습니다.");
        if (m === "PUT") {
          const d = this.readItemBody(await body(), true);
          if (d.no && this.first(`SELECT 1 AS x FROM items WHERE no=? AND id<>?`, d.no, id)) return err(409, `No.${d.no} 은(는) 이미 있습니다.`);
          const merged = { ...it, ...d };
          // 종료 시각을 미래로 바꾸면 다시 진행중으로 되돌림
          const reopen = it.settled_at && merged.end_at > Date.now();
          this.run(`UPDATE items SET no=?,name=?,description=?,donor=?,start_price=?,step=?,end_at=?,settled_at=?,winner_bid_id=? WHERE id=?`,
            merged.no, merged.name, merged.description, merged.donor, merged.start_price, merged.step, merged.end_at,
            reopen ? null : it.settled_at, reopen ? null : it.winner_bid_id, id);
          await this.afterItemChange();
          return json({ ok: true });
        }
        if (m === "DELETE") {
          this.run(`DELETE FROM items WHERE id=?`, id);
          this.run(`DELETE FROM bids WHERE item_id=?`, id);
          this.run(`DELETE FROM images WHERE item_id=?`, id);
          this.run(`DELETE FROM photos WHERE item_id=?`, id);
          await this.afterItemChange();
          return json({ ok: true });
        }
      }
      if ((mm = p.match(/^\/items\/([\w-]+)\/image$/))) {
        const id = mm[1];
        if (!this.first(`SELECT 1 AS x FROM items WHERE id=?`, id)) return err(404, "물품을 찾을 수 없습니다.");
        if (m === "PUT") {
          const { dataUrl } = await body();
          const g = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
          if (!g) return err(400, "이미지 형식이 올바르지 않습니다.");
          if (g[2].length > MAX_IMAGE_BYTES) return err(413, "이미지가 너무 큽니다.");
          this.run(`INSERT INTO images(item_id,mime,b64) VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET mime=excluded.mime,b64=excluded.b64`, id, g[1], g[2]);
        } else if (m === "DELETE") {
          this.run(`DELETE FROM images WHERE item_id=?`, id);
        } else return err(405, "method");
        this.run(`UPDATE items SET img_ver=COALESCE(img_ver,0)+1 WHERE id=?`, id);
        this.run(`UPDATE items SET img_ver=0 WHERE id=? AND NOT EXISTS(SELECT 1 FROM images WHERE item_id=?)`, id, id);
        this.broadcast();
        return json({ ok: true });
      }
      if ((mm = p.match(/^\/items\/([\w-]+)\/photos$/)) && m === "POST") {
        const id = mm[1];
        if (!this.first(`SELECT 1 AS x FROM items WHERE id=?`, id)) return err(404, "물품을 찾을 수 없습니다.");
        const cnt = this.first(`SELECT COUNT(*) AS c, COALESCE(MAX(ord),0) AS o FROM photos WHERE item_id=?`, id);
        if (cnt.c >= MAX_PHOTOS) return err(409, `상세사진은 ${MAX_PHOTOS}장까지 올릴 수 있습니다.`);
        const g = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((await body()).dataUrl || ""));
        if (!g) return err(400, "이미지 형식이 올바르지 않습니다.");
        if (g[2].length > MAX_IMAGE_BYTES) return err(413, "이미지가 너무 큽니다.");
        this.run(`INSERT INTO photos(item_id,ord,mime,b64) VALUES(?,?,?,?)`, id, cnt.o + 1, g[1], g[2]);
        const pid = this.first(`SELECT last_insert_rowid() AS id`).id;
        this.bumpPhotos(id); this.broadcast();
        return json({ ok: true, id: pid });
      }
      if ((mm = p.match(/^\/items\/([\w-]+)\/photos\/order$/)) && m === "PUT") {
        const id = mm[1];
        const ids = ((await body()).ids || []).map(int);
        ids.forEach((pid, i) => this.run(`UPDATE photos SET ord=? WHERE id=? AND item_id=?`, i + 1, pid, id));
        this.bumpPhotos(id); this.broadcast();
        return json({ ok: true });
      }
      if ((mm = p.match(/^\/photos\/(\d+)$/)) && m === "DELETE") {
        const ph = this.first(`SELECT item_id FROM photos WHERE id=?`, int(mm[1]));
        if (ph) { this.run(`DELETE FROM photos WHERE id=?`, int(mm[1])); this.bumpPhotos(ph.item_id); this.broadcast(); }
        return json({ ok: true });
      }
      if (p === "/samples" && m === "POST") return this.seedSamples();
      if (p === "/samples" && m === "DELETE") {
        const ids = this.all(`SELECT id FROM items WHERE is_sample=1`).map((r) => r.id);
        for (const id of ids) for (const t of ["bids", "images", "photos", "sms_log"]) this.run(`DELETE FROM ${t} WHERE item_id=?`, id);
        this.run(`DELETE FROM items WHERE is_sample=1`);
        this.run(`DELETE FROM sessions WHERE emp LIKE '9999%'`);
        await this.afterItemChange();
        return json({ ok: true, deleted: ids.length });
      }
      if (p === "/bulk-end" && m === "POST") {
        const t = int((await body()).endAt);
        if (!(t > 0)) return err(400, "종료 시각을 확인해 주세요.");
        const reopen = t > Date.now();
        this.run(reopen ? `UPDATE items SET end_at=?, settled_at=NULL, winner_bid_id=NULL` : `UPDATE items SET end_at=?`, t);
        await this.afterItemChange();
        return json({ ok: true });
      }
      if ((mm = p.match(/^\/bids\/(\d+)$/)) && m === "DELETE") {
        const bid = this.first(`SELECT b.*, i.settled_at FROM bids b JOIN items i ON i.id=b.item_id WHERE b.id=?`, int(mm[1]));
        if (!bid) return err(404, "입찰을 찾을 수 없습니다.");
        if (bid.settled_at) return err(409, "낙찰이 확정된 물품의 입찰은 취소할 수 없습니다.");
        this.run(`DELETE FROM bids WHERE id=?`, bid.id);
        this.broadcast();
        return json({ ok: true });
      }
      if ((mm = p.match(/^\/items\/([\w-]+)\/bids$/)) && m === "GET") {
        const rows = this.all(`SELECT id,emp,phone,amount,at FROM bids WHERE item_id=? ORDER BY amount DESC, at ASC`, mm[1])
          .map((r) => ({ ...r, phone: fmtPhone(r.phone) }));
        return json({ bids: rows });
      }
      if (p === "/settings" && m === "PUT") {
        const b = await body();
        if (typeof b.template === "string") {
          const t = b.template.trim().slice(0, 1000);
          if (t) this.setSetting("sms_template", t); else this.run(`DELETE FROM settings WHERE key='sms_template'`);
        }
        return json({ ok: true, template: this.template() });
      }
      if (p === "/sms-preview" && m === "POST") {
        const b = await body();
        const tpl = typeof b.template === "string" && b.template.trim() ? b.template : this.template();
        let vars = { event: this.eventName(), no: 1, name: "예시 물품", amount: 50000, emp: "123456" }, to = null;
        const it = b.itemId ? this.first(`SELECT * FROM items WHERE id=?`, String(b.itemId)) : null;
        if (it) {
          const top = this.topBid(it.id, it.end_at);
          const closed = Date.now() >= it.end_at;
          vars = { event: this.eventName(), no: it.no, name: it.name, amount: top ? top.amount : it.start_price, emp: top ? top.emp : "(낙찰자 사번)" };
          to = { emp: top ? top.emp : "", phone: top ? fmtPhone(top.phone) : "", state: !top ? (closed ? "unsold" : "nobid") : closed ? "sold" : "leading" };
        }
        const text = renderTemplate(tpl, vars);
        return json({ text, bytes: smsBytes(text), type: smsBytes(text) > 90 ? "LMS" : "SMS", to });
      }
      if ((mm = p.match(/^\/items\/([\w-]+)\/notify$/)) && m === "POST") {
        const it = this.first(`SELECT * FROM items WHERE id=?`, mm[1]);
        if (!it) return err(404, "물품을 찾을 수 없습니다.");
        if (Date.now() < it.end_at) return err(409, "아직 경매가 진행중입니다.");
        const top = this.topBid(it.id, it.end_at);
        if (!top) return err(409, "낙찰자가 없습니다.");
        await this.notifyWinner(it, top, "manual");
        return json({ ok: true });
      }
      if (p === "/export.csv" && m === "GET") return this.exportCsv(url.searchParams.get("type") || "winners");
      if (p === "/purge-personal" && m === "POST") {
        this.run(`UPDATE bids SET phone=NULL`);
        this.run(`DELETE FROM sessions WHERE is_admin<>1`);
        this.run(`UPDATE sms_log SET to_phone=''`);
        return json({ ok: true });
      }
      if (p === "/reset-all" && m === "POST") {
        const b = await body();
        if (b.confirm !== "전체삭제") return err(400, "확인 문구가 필요합니다.");
        for (const t of ["items", "images", "photos", "bids", "sms_log"]) this.run(`DELETE FROM ${t}`);
        await this.afterItemChange();
        return json({ ok: true });
      }
      return err(404, "not found");
    } catch (e) {
      if (e instanceof Error && /확인|입력/.test(e.message)) return err(400, e.message);
      throw e;
    }
  }

  // 미리보기용 샘플 물품: 이미 끝난 3개(낙찰/유찰), 곧 끝나는 1개, 진행중 4개. 입찰자는 가상의 사번(9999xx)
  async seedSamples() {
    if (this.first(`SELECT 1 AS x FROM items WHERE is_sample=1 LIMIT 1`)) return err(409, "샘플 물품이 이미 있습니다. 먼저 ‘샘플만 삭제’를 눌러 주세요.");
    const now = Date.now(), H = 3600e3, D = 24 * H;
    const base = this.first(`SELECT COALESCE(MAX(no),0) AS n FROM items`).n;
    const S = [
      ["[샘플] 무선 블루투스 스피커", 20000, 1000, now - 2 * H, [20000, 23000, 26000], "거의 새 제품입니다.\n박스, 충전 케이블 포함."],
      ["[샘플] 핸드드립 커피 세트", 15000, 1000, now - 1 * H, [15000, 17000], "드리퍼, 서버, 필터 100매 구성."],
      ["[샘플] 캐시미어 머플러", 30000, 2000, now - 30 * 60e3, [], "미개봉 새 상품입니다."],
      ["[샘플] 보드게임 세트", 10000, 1000, now + 3 * 60e3, [10000, 12000], "구성품 모두 있습니다. 3~6인용."],
      ["[샘플] 노이즈캔슬링 이어폰", 50000, 5000, now + 2 * D, [50000, 60000, 70000, 75000], "6개월 사용, 정상 작동합니다."],
      ["[샘플] 아로마 디퓨저", 10000, 1000, now + 2 * D, [], "리필 오일 2병 포함."],
      ["[샘플] 캠핑 랜턴", 20000, 2000, now + 3 * D, [20000], "USB 충전식, 3단 밝기."],
      ["[샘플] 와인 글라스 세트", 15000, 1000, now + 3 * D, [15000, 16000, 18000], "4개입, 선물 박스 포장."],
    ];
    const salt = this.getSetting("pid_salt");
    const ids = [];
    for (let i = 0; i < S.length; i++) {
      const [name, start, step, endAt, amounts, desc] = S[i];
      const id = "s" + Date.now().toString(36) + randHex(2) + i;
      this.run(`INSERT INTO items(id,no,name,description,donor,start_price,step,end_at,created_at,is_sample) VALUES(?,?,?,?,?,?,?,?,?,1)`,
        id, base + i + 1, name, desc, "샘플 기부자", start, step, endAt, now);
      for (let k = 0; k < amounts.length; k++) {
        const emp = String(999901 + ((i + k) % 5));
        const pid = (await sha256Hex(salt + ":" + emp)).slice(0, 16);
        const at = Math.min(endAt, now) - (amounts.length - k) * 7 * 60e3;
        this.run(`INSERT INTO bids(item_id,emp,phone,pid,amount,at) VALUES(?,?,?,?,?,?)`, id, emp, "0100000" + emp.slice(2), pid, amounts[k], at);
      }
      ids.push({ id, no: base + i + 1, name });
    }
    await this.afterItemChange();
    return json({ ok: true, items: ids });
  }

  async afterItemChange() {
    await this.scheduleAlarm();
    this.broadcast();
  }

  exportCsv(type) {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const dt = (ms) => (ms ? new Date(ms + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16) : "");
    let rows;
    if (type === "participants") {
      rows = [["사번", "휴대폰", "최초 접속(KST)", "마지막 접속(KST)", "입찰 수", "낙찰 물품 수", "관리자"]];
      const bidCnt = Object.fromEntries(this.all(`SELECT emp, COUNT(*) AS c FROM bids GROUP BY emp`).map((r) => [r.emp, r.c]));
      const winCnt = {};
      for (const it of this.items()) {
        if (Date.now() < it.end_at) continue;
        const top = this.topBid(it.id, it.end_at);
        if (top) winCnt[top.emp] = (winCnt[top.emp] || 0) + 1;
      }
      const people = new Map();
      for (const r of this.all(`SELECT emp, phone, created_at, is_admin FROM sessions ORDER BY created_at ASC`)) {
        const p = people.get(r.emp) || { first: r.created_at };
        p.last = r.created_at; p.phone = r.phone || p.phone; p.admin = p.admin || r.is_admin === 1;
        people.set(r.emp, p);
      }
      for (const [emp, p] of [...people].sort((a, b) => a[0].localeCompare(b[0])))
        rows.push([emp, fmtPhone(p.phone), dt(p.first), dt(p.last), bidCnt[emp] || 0, winCnt[emp] || 0, this.isAdminPair(emp, p.phone || "") ? "O" : ""]);
    } else if (type === "bids") {
      rows = [["번호", "물품명", "사번", "연락처", "입찰가", "입찰시각(KST)"]];
      for (const r of this.all(`SELECT i.no,i.name,b.emp,b.phone,b.amount,b.at FROM bids b JOIN items i ON i.id=b.item_id ORDER BY i.no, b.amount DESC`))
        rows.push([r.no, r.name, r.emp, fmtPhone(r.phone), r.amount, dt(r.at)]);
    } else {
      rows = [["번호", "물품명", "상태", "낙찰가", "사번", "연락처", "입찰수", "종료시각(KST)"]];
      for (const it of this.items()) {
        const s = this.summary(it);
        const top = this.topBid(it.id, it.end_at);
        rows.push([it.no, it.name, s.status === "sold" ? "낙찰완료" : s.status === "unsold" ? "유찰" : "진행중",
          s.status === "sold" ? top.amount : "", s.status === "sold" ? top.emp : "", s.status === "sold" ? fmtPhone(top.phone) : "", s.bidCount, dt(it.end_at)]);
      }
    }
    const csv = "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="auction-${type}.csv"`, "cache-control": "no-store" } });
  }
}
