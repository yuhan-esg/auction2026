// Cloudflare Durable Object 런타임을 흉내 내는 아주 작은 모의 환경 (테스트 전용)
import { DatabaseSync } from "node:sqlite";

export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}

export function makeCtx() {
  const db = new DatabaseSync(":memory:");
  const sockets = [];
  const ctx = {
    alarmAt: null,
    storage: {
      sql: { exec(q, ...a) { const rows = db.prepare(q).all(...a); return { toArray: () => rows, one: () => rows[0] }; } },
      async setAlarm(t) { ctx.alarmAt = t; },
      async getAlarm() { return ctx.alarmAt; },
      async deleteAlarm() { ctx.alarmAt = null; },
    },
    blockConcurrencyWhile(fn) { return fn(); },
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets.filter((s) => !s.closed); },
  };
  return ctx;
}

// WebSocketPair / 101 Response 흉내
export class MockServerWS {
  constructor() { this.queue = []; this.closed = false; this.sink = null; }
  send(t) { if (this.closed) throw new Error("closed"); this.sink ? this.sink(t) : this.queue.push(t); }
  attach(fn) { this.sink = fn; this.queue.splice(0).forEach(fn); }
  close() { this.closed = true; }
}
globalThis.WebSocketPair = class { constructor() { const s = new MockServerWS(); this[0] = { server: s }; this[1] = s; } };
const R = globalThis.Response;
globalThis.Response = class extends R {
  constructor(body, init = {}) {
    if (init.status === 101) { super(null, { status: 200 }); this._ws = init.webSocket; this._101 = true; }
    else super(body, init);
  }
  get status() { return this._101 ? 101 : super.status; }
  get webSocket() { return this._ws; }
};
