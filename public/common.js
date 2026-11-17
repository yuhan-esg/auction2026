// 참여자 화면과 관리자 화면이 함께 쓰는 도우미
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const won = (n) => (n == null || n === "" ? "-" : Number(n).toLocaleString("ko-KR") + "원");
export const pad = (n) => String(n).padStart(2, "0");
export const fmtDT = (ms) => { if (!ms) return "-"; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmtDTs = (ms) => { if (!ms) return "-"; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const fmtDTfull = (ms) => { if (!ms) return "-"; const d = new Date(ms); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}(${"일월화수목금토"[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const digits = (s) => String(s || "").replace(/\D/g, "");
export function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  if (d > 0) return `${d}일 ${h}시간 ${pad(m)}분`;
  return `${pad(h)}:${pad(m)}:${pad(x)}`;
}
export function moneyInput(el) {
  el.addEventListener("input", () => { const d = digits(el.value); el.value = d ? Number(d).toLocaleString("ko-KR") : ""; });
}
export function toast(t) {
  const el = $("#toast"); if (!el) return;
  el.textContent = t; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2400);
}
export function modal({ title, body, ok = "확인", cancel = "취소", danger = false, input = null }) {
  return new Promise((res) => {
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<div class="mbox" role="dialog" aria-modal="true"><h3></h3><p></p>${input ? `<input class="t" style="margin:-6px 0 16px">` : ""}<div class="row">${cancel ? `<button class="btn ghost" data-a="0">${esc(cancel)}</button>` : ""}<button class="btn ${danger ? "red" : ""}" data-a="1">${esc(ok)}</button></div></div>`;
    $("h3", m).textContent = title; $("p", m).textContent = body;
    const inp = $("input", m); if (inp) inp.placeholder = input;
    const done = (v) => { m.remove(); document.removeEventListener("keydown", onKey); res(v); };
    const onKey = (e) => { if (e.key === "Escape") done(input ? null : false); if (e.key === "Enter" && inp) done(inp.value); };
    m.addEventListener("click", (e) => {
      const a = e.target.dataset.a;
      if (a != null) done(a === "1" ? (inp ? inp.value : true) : (inp ? null : false));
      else if (e.target === m) done(inp ? null : false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(m);
    (inp || $('[data-a="1"]', m)).focus();
  });
}
export const GIFT_PH = `<div class="ph"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="18" width="34" height="23" rx="2"/><rect x="5" y="12" width="38" height="7" rx="1.5"/><path d="M24 12v29M24 12c-3-6-11-7-11-2s8 2 11 2c3 0 11 3 11-2s-8-4-11 2"/></svg>사진 준비중</div>`;
export const imgUrl = (it) => (it.imgVer > 0 ? `/api/img/${encodeURIComponent(it.id)}?v=${it.imgVer}` : "");

// 실시간 연결 (WebSocket, 끊기면 자동 재연결 + 20초마다 보조 새로고침)
export function connectLive({ onState, onStatus }) {
  let ws, retry = 0, pingT, alive = false;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
    ws.onopen = () => { retry = 0; alive = true; onStatus(true); clearInterval(pingT); pingT = setInterval(() => { try { ws.send("ping"); } catch (e) {} }, 25000); };
    ws.onmessage = (e) => { if (e.data === "pong") return; try { const d = JSON.parse(e.data); if (d.type === "state") onState(d); } catch (er) {} };
    ws.onclose = () => { alive = false; onStatus(false); clearInterval(pingT); setTimeout(open, Math.min(15000, 1000 * 2 ** retry++)); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  open();
  const poll = async () => { try { const r = await fetch("/api/state", { cache: "no-store" }); if (r.ok) onState(await r.json()); } catch (e) {} };
  poll();
  setInterval(() => { if (!alive) poll(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
}
