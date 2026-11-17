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
const DEFAULT_RAISES = [1000, 3000, 5000, 10000];
const DEFAULT_NOTICE = [
  "입찰 버튼을 누르면 **확인 없이 바로 입찰돼요**. 실수로 누르셨다면 마감 전에 경매 담당자에게 알려 주세요.",
  "마감 30초 안에 입찰이 들어오면 남은 시간이 30초로 다시 늘어나요. 마지막까지 누구에게나 기회가 있어요.",
  "같은 금액이 동시에 들어오면 **먼저 도착한 입찰**만 인정돼요.",
].join("\n");
// 물품별 입찰 버튼 금액 4개 (없으면 기본값)
function itemRaises(it) {
  try { const r = JSON.parse(it.raises || "null"); if (Array.isArray(r) && r.length) return r; } catch (e) {}
  return DEFAULT_RAISES;
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
    this.addColumn("items", "base_end_at", "INTEGER");
    this.addColumn("items", "raises", "TEXT");
    this.addColumn("sessions", "pin_sig", "TEXT");
    this.run(`CREATE TABLE IF NOT EXISTS admin_fail(k TEXT PRIMARY KEY, n INTEGER, until INTEGER)`);
    this.run(`CREATE TABLE IF NOT EXISTS admin_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, emp TEXT, action TEXT, item_no INTEGER, item_name TEXT, detail TEXT)`);
    this.run(`UPDATE items SET base_end_at=end_at WHERE base_end_at IS NULL`);
    this.run(`CREATE TABLE IF NOT EXISTS wishes(item_id TEXT NOT NULL, pid TEXT NOT NULL, emp TEXT NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(item_id, pid))`);
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
  // 아주 간단한 메모리 제한기 (키별 window 안에 max 회)
  limited(key, max, windowMs) {
    const now = Date.now();
    this.rl = this.rl || new Map();
    if (this.rl.size > 20000) this.rl.clear();
    const e = this.rl.get(key);
    if (!e || now - e.t > windowMs) { this.rl.set(key, { t: now, n: 1 }); return false; }
    e.n++;
    return e.n > max;
  }
  // ADMIN_PIN 비밀값의 서명 (PIN을 바꾸면 기존 관리자 로그인이 모두 풀림)
  async pinSig() {
    const pin = String(this.env.ADMIN_PIN || "");
    if (!pin) return "";
    if (this._pinFor !== pin) { this._pinFor = pin; this._pinSig = (await sha256Hex("pin:" + pin)).slice(0, 24); }
    return this._pinSig;
  }
  isAdminPair(emp, phone) { const s = this.adminUsers().get(emp); return !!(s && s.has(phone)); }
  getSetting(k) { const r = this.first(`SELECT value FROM settings WHERE key=?`, k); return r ? r.value : null; }
  setSetting(k, v) { this.run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, String(v)); }

  // 참여자 화면 공지 (관리자가 수정, 빈 칸이면 숨김)
  notice() {
    const v = this.getSetting("notice");
    return v === null ? DEFAULT_NOTICE : v;
  }
  // 관리자 작업 기록
  audit(s, action, item, detail = "") {
    this.run(`INSERT INTO admin_log(at,emp,action,item_no,item_name,detail) VALUES(?,?,?,?,?,?)`,
      Date.now(), s ? s.emp : "", action, item ? item.no : null, item ? item.name : "", String(detail).slice(0, 500));
  }
  eventName() { return this.getSetting("event_name") || this.env.EVENT_NAME || "연말 나눔 경매"; }
  template() { return this.getSetting("sms_template") || DEFAULT_TEMPLATE; }
  // 마감 직전 연장(초): 관리자 화면 설정 > wrangler 변수 > 기본 30초. 0이면 끔
  antiSnipeMs() {
    const v = this.getSetting("extend_seconds") ?? this.env.ANTI_SNIPE_SECONDS ?? "30";
    return Math.max(0, int(v) || 0) * 1000;
  }
  // 일정: 경매 시작 시각(이전엔 입찰 불가), 희망가 접수 마감
  schedule(now = Date.now()) {
    const startAt = int(this.getSetting("start_at")) || null;
    const wishEndAt = int(this.getSetting("wish_end_at")) || null;
    const started = !startAt || now >= startAt;
    // 희망가는 경매 시작 전에만 (희망가 마감을 정했으면 그때까지)
    const wishOpen = !started && (!wishEndAt || now < wishEndAt);
    return { startAt, wishEndAt, started, wishOpen, extendSeconds: this.antiSnipeMs() / 1000 };
  }

  topBid(itemId, endAt) {
    return this.first(`SELECT * FROM bids WHERE item_id=? AND at<=? ORDER BY amount DESC, at ASC LIMIT 1`, itemId, endAt);
  }

  summary(it, now = Date.now()) {
    const top = this.topBid(it.id, it.end_at);
    const cnt = this.first(`SELECT COUNT(*) AS c FROM bids WHERE item_id=? AND at<=?`, it.id, it.end_at).c;
    const closed = now >= it.end_at;
    const wc = this.first(`SELECT COUNT(*) AS c FROM wishes WHERE item_id=?`, it.id).c;
    return {
      id: it.id, no: it.no, name: it.name, sample: !!it.is_sample, description: it.description, donor: it.donor,
      start: it.start_price, step: it.step, raises: itemRaises(it), endAt: it.end_at, imgVer: it.img_ver || 0, photoVer: it.photo_ver || 0,
      bidCount: cnt,
      top: top ? { amount: top.amount, emp: maskEmp(top.emp), pid: top.pid, at: top.at } : null,
      minNext: top ? top.amount + it.step : Math.max(it.start_price, it.step),
      wishCount: wc, baseEndAt: it.base_end_at || it.end_at, extended: !!(it.base_end_at && it.end_at > it.base_end_at),
      status: closed ? (top ? "sold" : "unsold") : "live",
    };
  }
  items() { return this.all(`SELECT * FROM items ORDER BY no ASC`); }
  state() {
    const now = Date.now();
    return { now, eventName: this.eventName(), notice: this.notice(), faviconVer: int(this.getSetting("favicon_ver")) || 0, schedule: this.schedule(now), items: this.items().map((it) => this.summary(it, now)) };
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
    return !!(s && s.is_admin === 1 && this.isAdminPair(s.emp, s.phone || "") && (s.pin_sig || "") === (this._curPinSig || ""));
  }

  async route(request) {
    this._curPinSig = await this.pinSig();
    this._ip = request.headers.get("cf-connecting-ip") || "local";
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
    if (p === "/api/wish" && m === "POST") return this.wish(request);
    if (p === "/api/my" && m === "GET") {
      const s = this.session(request);
      if (!s) return err(401, "로그인이 필요합니다.");
      const wishes = Object.fromEntries(this.all(`SELECT item_id, amount FROM wishes WHERE pid=?`, s.pid).map((r) => [r.item_id, r.amount]));
      const bidItems = this.all(`SELECT DISTINCT item_id FROM bids WHERE pid=?`, s.pid).map((r) => r.item_id);
      return json({ wishes, bidItems });
    }
    let mm;
    if ((mm = p.match(/^\/api\/items\/([\w-]+)$/)) && m === "GET") return this.itemDetail(mm[1]);
    if ((mm = p.match(/^\/api\/img\/([\w-]+)$/)) && m === "GET") return this.image(mm[1]);
    if ((mm = p.match(/^\/api\/photo\/(\d+)$/)) && m === "GET") return this.photo(int(mm[1]));
    if (p === "/api/favicon" && m === "GET") {
      const f = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(this.getSetting("favicon") || "");
      if (!f) return new Response(null, { status: 302, headers: { location: "/favicon.svg" } });
      return new Response(Uint8Array.from(atob(f[2]), (c) => c.charCodeAt(0)), { headers: { "content-type": f[1], "cache-control": "public, max-age=31536000, immutable" } });
    }

    if (p.startsWith("/api/admin/")) {
      const s = this.session(request);
      if (!s) return err(401, "로그인이 필요합니다.");
      if (!this.sessionIsAdmin(s)) return err(403, "관리자로 지정된 계정이 아닙니다.");
      return this.admin(request, p.slice("/api/admin".length), m, url, s);
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
    if (this.limited("login:" + this._ip, 60, 60e3)) return err(429, "로그인 시도가 너무 많습니다. 1분 뒤에 다시 해 주세요.");
    let isAdmin = false;
    const wantsAdmin = b.admin === true;
    if (wantsAdmin) {
      // 관리자 로그인: 사번+번호가 명단과 맞고, ADMIN_PIN이 정해져 있으면 PIN도 맞아야 함. 5번 틀리면 15분 잠금
      const now = Date.now();
      const keys = ["emp:" + emp, "ip:" + this._ip];
      for (const k of keys) {
        const f = this.first(`SELECT n, until FROM admin_fail WHERE k=?`, k);
        if (f && f.until > now) return err(429, `관리자 로그인이 잠겼습니다. ${Math.ceil((f.until - now) / 60e3)}분 뒤에 다시 시도해 주세요.`);
      }
      const pinOk = !this._curPinSig || (await sha256Hex("pin:" + String(b.pin || ""))).slice(0, 24) === this._curPinSig;
      isAdmin = this.isAdminPair(emp, phone) && pinOk;
      if (!isAdmin) {
        for (const k of keys) {
          const f = this.first(`SELECT n, until FROM admin_fail WHERE k=?`, k);
          const n = (f && f.until <= now && f.n >= 5 ? 0 : f ? f.n : 0) + 1;
          this.run(`INSERT INTO admin_fail(k,n,until) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET n=excluded.n, until=excluded.until`, k, n, n >= 5 ? now + 15 * 60e3 : 0);
        }
        return err(403, "관리자 정보가 맞지 않습니다.", { code: "admin_denied" });
      }
      for (const k of keys) this.run(`DELETE FROM admin_fail WHERE k=?`, k);
    } else {
      // 일반 로그인이라도 명단과 맞고 PIN이 없으면 관리자 (PIN을 정했다면 관리자 화면에서 PIN으로 로그인해야 함)
      isAdmin = !this._curPinSig && this.isAdminPair(emp, phone);
    }
    const token = randHex(24);
    const pid = (await sha256Hex(this.getSetting("pid_salt") + ":" + emp)).slice(0, 16);
    this.run(`INSERT INTO sessions(token,emp,phone,pid,created_at,is_admin,pin_sig) VALUES(?,?,?,?,?,?,?)`, token, emp, phone, pid, Date.now(), isAdmin ? 1 : 0, isAdmin ? this._curPinSig : "");
    // 한 사번당 로그인 기기는 최근 5개까지만 유지
    this.run(`DELETE FROM sessions WHERE emp=? AND token NOT IN (SELECT token FROM sessions WHERE emp=? ORDER BY created_at DESC LIMIT 5)`, emp, emp);
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
    if (now - (s.last_bid_at || 0) < BID_COOLDOWN_MS) return err(429, "너무 빨리 누르셨어요. 1초 뒤에 다시 눌러 주세요.");
    const top = this.topBid(it.id, it.end_at);
    if (!this.schedule(now).started) return err(409, "아직 경매가 시작되지 않았습니다.", { code: "not_started" });
    const min = top ? top.amount + it.step : Math.max(it.start_price, it.step);
    if (top && amount === top.amount) {
      const gap = Math.max(1, now - top.at);
      const when = gap < 100 ? "아주 근소한 차이(0.1초 미만)로" : gap < 1000 ? `${(gap / 1000).toFixed(1)}초 차이로` : `${Math.round(gap / 1000)}초 먼저`;
      return err(409, `같은 금액(${amount.toLocaleString("ko-KR")}원)이 ${when} 먼저 들어왔어요.\n먼저 도착한 입찰만 인정돼요.`, { code: "same_amount", minNext: min, gapMs: gap });
    }
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

  async wish(request) {
    const s = this.session(request);
    if (!s) return err(401, "로그인이 필요합니다.");
    const b = await request.json().catch(() => ({}));
    const it = this.first(`SELECT * FROM items WHERE id=?`, String(b.itemId || ""));
    if (!it) return err(404, "물품을 찾을 수 없습니다.");
    if (!this.schedule().wishOpen) return err(409, "희망가 접수 기간이 아닙니다.", { code: "wish_closed" });
    if (this.limited("wish:" + s.token, 1, 1000)) return err(429, "너무 빨리 누르셨어요. 1초 뒤에 다시 해 주세요.");
    if (b.amount === null || b.amount === 0) {
      this.run(`DELETE FROM wishes WHERE item_id=? AND pid=?`, it.id, s.pid);
    } else {
      const amount = int(b.amount);
      if (!(amount > 0) || amount > MAX_AMOUNT) return err(400, "금액을 확인해 주세요.");
      this.run(`INSERT INTO wishes(item_id,pid,emp,amount,at) VALUES(?,?,?,?,?) ON CONFLICT(item_id,pid) DO UPDATE SET amount=excluded.amount, emp=excluded.emp, at=excluded.at`, it.id, s.pid, s.emp, amount, Date.now());
    }
    this.sendAll(JSON.stringify({ type: "item", now: Date.now(), item: this.summary(it) }));
    return json({ ok: true });
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
    if (Array.isArray(b.raises)) {
      const r = b.raises.map(int);
      if (r.length !== 4 || r.some((x) => !(x > 0) || x > MAX_AMOUNT)) throw new Error("입찰 버튼 금액 4개를 모두 확인해 주세요.");
      out.raises = JSON.stringify([...r].sort((x, y) => x - y));
      out.step = Math.min(...r); // 가장 작은 버튼 금액 = 최소로 올릴 수 있는 금액
    } else if (b.step !== undefined) {
      out.step = int(b.step); if (!(out.step > 0)) throw new Error("버튼 금액을 확인해 주세요.");
      out.raises = JSON.stringify([1, 3, 5, 10].map((k) => k * out.step));
    } else if (!partial) { out.step = DEFAULT_RAISES[0]; out.raises = JSON.stringify(DEFAULT_RAISES); }
    if (need("endAt")) { out.end_at = int(b.endAt); if (!(out.end_at > 0)) throw new Error("종료 시각을 확인해 주세요."); }
    return out;
  }

  adminOverview() {
    const now = Date.now();
    const items = this.items().map((it) => {
      const s = this.summary(it, now);
      const top = this.topBid(it.id, it.end_at);
      const ws = this.all(`SELECT amount FROM wishes WHERE item_id=? ORDER BY amount`, it.id).map((r) => r.amount);
      const med = ws.length ? (ws.length % 2 ? ws[(ws.length - 1) / 2] : Math.round((ws[ws.length / 2 - 1] + ws[ws.length / 2]) / 2)) : null;
      const wish = ws.length ? { count: ws.length, avg: Math.round(ws.reduce((a, b) => a + b, 0) / ws.length), median: med, min: ws[0], max: ws[ws.length - 1] } : { count: 0 };
      return { ...s, wish, settledAt: it.settled_at,
        winner: s.status === "sold" && top ? { emp: top.emp, phone: fmtPhone(top.phone), amount: top.amount, at: top.at } : null,
        leader: top ? { emp: top.emp, phone: fmtPhone(top.phone), amount: top.amount } : null };
    });
    const sms = this.all(`SELECT * FROM sms_log ORDER BY id DESC LIMIT 200`).map((r) => ({ ...r, to_phone: fmtPhone(r.to_phone) }));
    const stats = this.first(`SELECT COUNT(*) AS bids, COUNT(DISTINCT pid) AS bidders FROM bids`);
    const sessions = this.first(`SELECT COUNT(DISTINCT emp) AS c FROM sessions`).c;
    return { now, eventName: this.eventName(), faviconVer: int(this.getSetting("favicon_ver")) || 0, hasFavicon: !!this.getSetting("favicon"), adminPinSet: !!this._curPinSig, notice: this.notice(), defaultNotice: DEFAULT_NOTICE, smsMode: smsMode(this.env), template: this.template(), defaultTemplate: DEFAULT_TEMPLATE,
      antiSnipeSeconds: this.antiSnipeMs() / 1000, schedule: this.schedule(now), items, sms, stats: { ...stats, participants: sessions } };
  }

  async admin(request, p, m, url, sess) {
    const body = async () => request.json().catch(() => ({}));
    let mm;
    try {
      if (p === "/overview" && m === "GET") return json(this.adminOverview());

      if (p === "/items" && m === "POST") {
        const d = this.readItemBody(await body());
        if (this.first(`SELECT 1 AS x FROM items WHERE no=?`, d.no)) return err(409, `No.${d.no} 은(는) 이미 있습니다.`);
        const id = "i" + Date.now().toString(36) + randHex(2);
        this.run(`INSERT INTO items(id,no,name,description,donor,start_price,step,raises,end_at,base_end_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          id, d.no, d.name, d.description, d.donor, d.start_price, d.step, d.raises, d.end_at, d.end_at, Date.now());
        this.audit(sess, "물품 등록", { no: d.no, name: d.name }, `시작가 ${d.start_price.toLocaleString("ko-KR")}원`);
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
          this.run(`UPDATE items SET no=?,name=?,description=?,donor=?,start_price=?,step=?,raises=?,end_at=?,settled_at=?,winner_bid_id=? WHERE id=?`,
            merged.no, merged.name, merged.description, merged.donor, merged.start_price, merged.step, merged.raises ?? null, merged.end_at,
            reopen ? null : it.settled_at, reopen ? null : it.winner_bid_id, id);
          if (d.end_at) this.run(`UPDATE items SET base_end_at=end_at WHERE id=?`, id);
          const ch = [];
          if (d.start_price !== undefined && d.start_price !== it.start_price) ch.push(`시작가 ${it.start_price.toLocaleString("ko-KR")}→${d.start_price.toLocaleString("ko-KR")}원`);
          if (d.end_at && d.end_at !== it.end_at) ch.push(`종료 시각 변경${reopen ? " (다시 진행)" : ""}`);
          if (d.raises && d.raises !== it.raises) ch.push(`버튼 금액 ${JSON.parse(d.raises).join("/")}`);
          if (d.name && d.name !== it.name) ch.push(`이름 ${it.name}→${d.name}`);
          this.audit(sess, "물품 수정", merged, ch.join(", ") || "설명 등 수정");
          await this.afterItemChange();
          return json({ ok: true });
        }
        if (m === "DELETE") {
          const nb = this.first(`SELECT COUNT(*) AS c FROM bids WHERE item_id=?`, id).c;
          this.audit(sess, "물품 삭제", it, nb ? `입찰 ${nb}건 함께 삭제` : "");
          this.run(`DELETE FROM items WHERE id=?`, id);
          this.run(`DELETE FROM bids WHERE item_id=?`, id);
          this.run(`DELETE FROM images WHERE item_id=?`, id);
          this.run(`DELETE FROM photos WHERE item_id=?`, id);
          this.run(`DELETE FROM wishes WHERE item_id=?`, id);
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
      if (p === "/schedule" && m === "PUT") {
        const b = await body();
        const put = (k, v) => (v ? this.setSetting(k, int(v)) : this.run(`DELETE FROM settings WHERE key=?`, k));
        if ("startAt" in b) put("start_at", b.startAt);
        if ("wishEndAt" in b) put("wish_end_at", b.wishEndAt);
        if (typeof b.favicon === "string") {
          if (!b.favicon) this.run(`DELETE FROM settings WHERE key='favicon'`);
          else if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.favicon) && b.favicon.length < 200000) this.setSetting("favicon", b.favicon);
          else return err(400, "아이콘 이미지 형식이 올바르지 않습니다.");
          this.setSetting("favicon_ver", (int(this.getSetting("favicon_ver")) || 0) + 1);
        }
        if (typeof b.eventName === "string") { const n = b.eventName.trim().slice(0, 40); n ? this.setSetting("event_name", n) : this.run(`DELETE FROM settings WHERE key='event_name'`); }
        if ("extendSeconds" in b) { const v = Math.max(0, Math.min(600, int(b.extendSeconds) || 0)); this.setSetting("extend_seconds", v); }
        if (typeof b.notice === "string") this.setSetting("notice", b.notice.trim().slice(0, 1500));
        const parts = [];
        if ("startAt" in b || "wishEndAt" in b) parts.push("경매 일정");
        if ("extendSeconds" in b) parts.push(`연장 ${int(b.extendSeconds) || 0}초`);
        if (typeof b.eventName === "string") parts.push("행사 이름");
        if (typeof b.notice === "string") parts.push("공지");
        if (typeof b.favicon === "string") parts.push("탭 아이콘");
        this.audit(sess, "설정 변경", null, parts.join(", "));
        this.broadcast();
        return json({ ok: true, schedule: this.schedule() });
      }
      if ((mm = p.match(/^\/items\/([\w-]+)\/wishes$/)) && m === "GET") {
        return json({ wishes: this.all(`SELECT emp, amount, at FROM wishes WHERE item_id=? ORDER BY amount DESC, at ASC`, mm[1]) });
      }
      if (p === "/log" && m === "GET") return json({ log: this.all(`SELECT * FROM admin_log ORDER BY id DESC LIMIT 500`) });
      if (p === "/samples" && m === "POST") {
        const b = await body();
        this.audit(sess, "샘플 물품 넣기", null, `${int(b.count) || 8}개 · ${({ ready: "준비중", live: "진행중", done: "완료", mix: "골고루" })[b.status] || "골고루"}`);
        return this.seedSamples(b.count, b.status);
      }
      if (p === "/roster" && m === "GET") return json({ rows: this.roster() });
      if (p === "/samples" && m === "DELETE") {
        const ids = this.all(`SELECT id FROM items WHERE is_sample=1`).map((r) => r.id);
        for (const id of ids) for (const t of ["bids", "images", "photos", "sms_log", "wishes"]) this.run(`DELETE FROM ${t} WHERE item_id=?`, id);
        this.run(`DELETE FROM items WHERE is_sample=1`);
        this.audit(sess, "샘플 물품 삭제", null, `${ids.length}개`);
        this.run(`DELETE FROM sessions WHERE emp LIKE '9999%'`);
        await this.afterItemChange();
        return json({ ok: true, deleted: ids.length });
      }
      if (p === "/bulk-end" && m === "POST") {
        const t = int((await body()).endAt);
        if (!(t > 0)) return err(400, "종료 시각을 확인해 주세요.");
        const reopen = t > Date.now();
        this.run(reopen ? `UPDATE items SET end_at=?, base_end_at=?, settled_at=NULL, winner_bid_id=NULL` : `UPDATE items SET end_at=?, base_end_at=?`, t, t);
        this.audit(sess, "종료 시각 일괄 변경", null, new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "));
        await this.afterItemChange();
        return json({ ok: true });
      }
      if ((mm = p.match(/^\/bids\/(\d+)$/)) && m === "DELETE") {
        const bid = this.first(`SELECT b.*, i.settled_at FROM bids b JOIN items i ON i.id=b.item_id WHERE b.id=?`, int(mm[1]));
        if (!bid) return err(404, "입찰을 찾을 수 없습니다.");
        if (bid.settled_at) return err(409, "낙찰이 확정된 물품의 입찰은 취소할 수 없습니다.");
        this.run(`DELETE FROM bids WHERE id=?`, bid.id);
        const bit = this.first(`SELECT * FROM items WHERE id=?`, bid.item_id);
        this.audit(sess, "입찰 취소", bit, `사번 ${bid.emp} · ${bid.amount.toLocaleString("ko-KR")}원 · 입찰 시각 ${new Date(bid.at + 9 * 3600e3).toISOString().slice(5, 19).replace("T", " ")}`);
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
        this.audit(sess, "낙찰 문자 다시 보내기", it, `사번 ${top.emp}`);
        return json({ ok: true });
      }
      if (p === "/export.csv" && m === "GET") return this.exportCsv(url.searchParams.get("type") || "winners");
      if (p === "/purge-personal" && m === "POST") {
        this.run(`UPDATE bids SET phone=NULL`);
        this.run(`DELETE FROM sessions WHERE is_admin<>1`);
        this.run(`UPDATE sms_log SET to_phone=''`);
        this.audit(sess, "휴대폰 번호 전체 삭제", null);
        return json({ ok: true });
      }
      if (p === "/reset-all" && m === "POST") {
        const b = await body();
        if (b.confirm !== "전체삭제") return err(400, "확인 문구가 필요합니다.");
        for (const t of ["items", "images", "photos", "bids", "sms_log", "wishes"]) this.run(`DELETE FROM ${t}`);
        this.audit(sess, "전체 초기화", null);
        await this.afterItemChange();
        return json({ ok: true });
      }
      return err(404, "not found");
    } catch (e) {
      if (e instanceof Error && /확인|입력/.test(e.message)) return err(400, e.message);
      throw e;
    }
  }

  // 미리보기용 샘플 물품. status: ready(입찰 없음) | live(입찰 진행중) | done(이미 낙찰) | mix(골고루)
  async seedSamples(count = 8, status = "mix") {
    count = Math.max(1, Math.min(30, int(count) || 8));
    if (!["ready", "live", "done", "mix"].includes(status)) status = "mix";
    const POOL = [
      ["무선 블루투스 스피커", 20000, "거의 새 제품입니다.\n박스, 충전 케이블 포함."], ["핸드드립 커피 세트", 15000, "드리퍼, 서버, 필터 100매 구성."],
      ["캐시미어 머플러", 30000, "미개봉 새 상품입니다."], ["보드게임 세트", 10000, "구성품 모두 있습니다. 3~6인용."],
      ["노이즈캔슬링 이어폰", 50000, "6개월 사용, 정상 작동합니다."], ["아로마 디퓨저", 10000, "리필 오일 2병 포함."],
      ["캠핑 랜턴", 20000, "USB 충전식, 3단 밝기."], ["와인 글라스 세트", 15000, "4개입, 선물 박스 포장."],
      ["미니 공기청정기", 40000, "필터 교체 3개월 전."], ["베스트셀러 도서 5권", 10000, "깨끗하게 읽었습니다."],
      ["전기 주전자", 15000, "1.7L, 정상 작동."], ["스마트 워치 밴드 세트", 10000, "3종 색상."],
    ];
    const now = Date.now(), H = 3600e3, D = 24 * H;
    const base = this.first(`SELECT COALESCE(MAX(no),0) AS n FROM items`).n;
    const used = this.first(`SELECT COUNT(*) AS c FROM items WHERE is_sample=1`).c;
    const salt = this.getSetting("pid_salt");
    const out = [];
    for (let i = 0; i < count; i++) {
      const [name0, start, desc] = POOL[(used + i) % POOL.length];
      const name = "[샘플] " + name0;
      const st = status === "mix" ? ["ready", "live", "done"][i % 3] : status;
      const step = start >= 30000 ? 2000 : 1000;
      // 마감 시각: 완료 = 이미 끝남, 진행중·준비중 = 며칠 뒤 (번갈아 가며 조금씩 다르게)
      const endAt = st === "done" ? now - (1 + i) * H : now + (2 + (i % 3)) * D + i * 5 * 60e3;
      const nb = st === "ready" ? 0 : 2 + (i % 3);
      const id = "s" + Date.now().toString(36) + randHex(2) + i;
      this.run(`INSERT INTO items(id,no,name,description,donor,start_price,step,raises,end_at,base_end_at,created_at,is_sample) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`,
        id, base + i + 1, name, desc, "샘플 기부자", start, step, JSON.stringify([1, 3, 5, 10].map((k) => k * step)), endAt, endAt, now);
      for (let k = 0; k < nb; k++) {
        const emp = String(999901 + ((i + k) % 5));
        const pid = (await sha256Hex(salt + ":" + emp)).slice(0, 16);
        const at = Math.min(endAt, now) - (nb - k) * 7 * 60e3;
        this.run(`INSERT INTO bids(item_id,emp,phone,pid,amount,at) VALUES(?,?,?,?,?,?)`, id, emp, "0100000" + emp.slice(2), pid, start + k * step * 3, at);
      }
      out.push({ id, no: base + i + 1, name, status: st });
    }
    await this.afterItemChange();
    return json({ ok: true, items: out });
  }

  // 데이터 관리: 참여자 × 입찰한 물품 (입찰이 없으면 한 줄)
  roster() {
    const now = Date.now();
    const items = Object.fromEntries(this.items().map((it) => [it.id, it]));
    const tops = {};
    for (const it of Object.values(items)) tops[it.id] = this.topBid(it.id, it.end_at);
    const people = new Map();
    for (const r of this.all(`SELECT emp, phone, created_at FROM sessions ORDER BY created_at ASC`)) {
      const p = people.get(r.emp) || { emp: r.emp, phone: "", first: r.created_at };
      if (r.phone) p.phone = r.phone; people.set(r.emp, p);
    }
    const bidsBy = new Map();
    for (const b of this.all(`SELECT emp, phone, item_id, MAX(amount) AS mine FROM bids GROUP BY emp, item_id`)) {
      if (!items[b.item_id]) continue;
      if (!people.has(b.emp)) people.set(b.emp, { emp: b.emp, phone: b.phone || "", first: 0 });
      else if (!people.get(b.emp).phone && b.phone) people.get(b.emp).phone = b.phone;
      (bidsBy.get(b.emp) || bidsBy.set(b.emp, []).get(b.emp)).push(b);
    }
    const lastSms = {};
    for (const r of this.all(`SELECT item_id, status FROM sms_log WHERE kind<>'test' ORDER BY id ASC`)) lastSms[r.item_id] = r.status;
    const rows = [];
    for (const p of people.values()) {
      const list = bidsBy.get(p.emp) || [];
      if (!list.length) { rows.push({ emp: p.emp, phone: fmtPhone(p.phone), item: null, state: "none", amount: null, mine: null, sms: null }); continue; }
      for (const b of list) {
        const it = items[b.item_id], top = tops[it.id], closed = now >= it.end_at;
        const isTop = top && top.emp === p.emp;
        const state = closed ? (isTop ? "won" : "lost") : isTop ? "leading" : "outbid";
        rows.push({ emp: p.emp, phone: fmtPhone(p.phone), item: { id: it.id, no: it.no, name: it.name }, state,
          amount: top ? top.amount : it.start_price, mine: b.mine, sms: state === "won" ? lastSms[it.id] || "none" : null });
      }
    }
    const order = { won: 0, leading: 1, outbid: 2, lost: 3, none: 4 };
    rows.sort((a, b) => order[a.state] - order[b.state] || (a.item?.no || 0) - (b.item?.no || 0) || a.emp.localeCompare(b.emp));
    return rows;
  }

  async afterItemChange() {
    await this.scheduleAlarm();
    this.broadcast();
  }

  exportCsv(type) {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const dt = (ms) => (ms ? new Date(ms + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16) : "");
    let rows;
    if (type === "roster") {
      const L = { won: "낙찰완료", leading: "진행중 · 최고가", outbid: "진행중 · 추월됨", lost: "미낙찰", none: "입찰 없음" };
      const SM = { preview: "미리보기", sent: "발송완료", failed: "실패", none: "기록 없음" };
      rows = [["번호", "사번", "휴대폰", "물품명", "상태", "낙찰가/현재가", "내 최고 입찰가", "문자"]];
      this.roster().forEach((r, i) => rows.push([i + 1, r.emp, r.phone, r.item ? r.item.name : "", L[r.state], r.amount ?? "", r.mine ?? "", r.sms ? SM[r.sms] : ""]));
    } else if (type === "wishes") {
      rows = [["번호", "물품명", "사번", "희망가", "등록시각(KST)"]];
      for (const r of this.all(`SELECT i.no,i.name,w.emp,w.amount,w.at FROM wishes w JOIN items i ON i.id=w.item_id ORDER BY i.no, w.amount DESC`))
        rows.push([r.no, r.name, r.emp, r.amount, dt(r.at)]);
    } else if (type === "participants") {
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
