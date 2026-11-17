// 테스트 전용 로컬 서버 (wrangler 없이 화면 확인용). 실제 개발은 `npm run dev` 를 쓰세요.
// node --no-warnings --import ./test/register.mjs test/dev-server.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { makeCtx } from "./mock-cf.mjs";
const { Auction } = await import("../src/auction.js");

const PORT = Number(process.env.PORT || 8787);
const env = { ADMIN_USERS: process.env.ADMIN_USERS || "999999:01099999999", SMS_MODE: "dry-run", EVENT_NAME: "연말 나눔 경매", ANTI_SNIPE_SECONDS: "0" };
const ctx = makeCtx();
const dobj = new Auction(ctx, env);
const PUB = new URL("../public/", import.meta.url).pathname;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

setInterval(async () => { if (ctx.alarmAt && Date.now() >= ctx.alarmAt) { ctx.alarmAt = null; await dobj.alarm(); } }, 200);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await dobj.fetch(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const p = url.pathname === "/" ? "/index.html" : url.pathname;
  try { const b = await readFile(join(PUB, p)); res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("not found"); }
});

// 최소한의 WebSocket 구현
server.on("upgrade", async (req, sock) => {
  const r = await dobj.fetch(new Request(`http://x${req.url}`, { headers: req.headers }));
  if (r.status !== 101) { sock.destroy(); return; }
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const srv = r.webSocket.server;
  srv.attach((text) => {
    const p = Buffer.from(text); let h;
    if (p.length < 126) h = Buffer.from([0x81, p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    if (!sock.destroyed) sock.write(Buffer.concat([h, p]));
  });
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { srv.close(); sock.end(); return; }
      if (op === 1) dobj.webSocketMessage(srv, data.toString());
    }
  });
  sock.on("close", () => srv.close()); sock.on("error", () => srv.close());
});
server.listen(PORT, () => console.log(`http://localhost:${PORT}  (관리자: ${env.ADMIN_USERS})`));
