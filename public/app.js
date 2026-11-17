import { $, $$, esc, won, fmtDT, fmtDTs, fmtDTfull, countdown, digits, toast, modal, GIFT_PH, imgUrl, connectLive, applyFavicon } from "./common.js";

const LS = "auction.session.v1";
const S = {
  items: [], loaded: false, offset: 0, event: "연말 나눔 경매",
  me: null, filter: "all", prevPrice: {}, detail: null, detailId: null, busy: false,
  schedule: { startAt: null, wishEndAt: null }, myWishes: {},
};
// 일정은 서버 시각 기준으로 매번 계산
const started = () => !S.schedule.startAt || now() >= S.schedule.startAt;
const wishOpen = () => !started() && (!S.schedule.wishEndAt || now() < S.schedule.wishEndAt);
const now = () => Date.now() + S.offset;
const maskEmp = (e) => (e ? e.slice(0, 2) + "**" + e.slice(4) : "");

function loadMe() { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) { return null; } }
function saveMe(v) { try { v ? localStorage.setItem(LS, JSON.stringify(v)) : localStorage.removeItem(LS); } catch (e) {} }

async function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (S.me?.token) headers.authorization = "Bearer " + S.me.token;
  const r = await fetch(path, { ...opts, headers, cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.me) { S.me = null; saveMe(null); render(); }
  if (!r.ok) throw Object.assign(new Error(data.error || "요청에 실패했습니다."), { status: r.status, data });
  return data;
}

function st(it) {
  const left = it.endAt - now();
  const closed = left <= 0 || it.status !== "live";
  const mineTop = !!(S.me && it.top && it.top.pid === S.me.pid);
  const mineIn = !!(S.me && S.myItems && S.myItems.has(it.id));
  const pre = !started() && !closed;
  return { left, closed, sold: !!it.top, mineTop, mineIn, pre, myWish: S.myWishes[it.id] || null };
}

/* ---------------- boot ---------------- */
async function boot() {
  S.me = loadMe();
  S.myItems = new Set(JSON.parse(localStorage.getItem(LS + ".items") || "[]"));
  if (S.me) { try { const m = await api("/api/me"); S.me.isAdmin = !!m.isAdmin; saveMe(S.me); await loadMy(); } catch (e) { if (e.status === 401) { S.me = null; saveMe(null); } } }
  connectLive({
    onState: (d) => {
      S.offset = d.now - Date.now();
      S.items = d.items; S.loaded = true;
      if (d.schedule) S.schedule = d.schedule;
      applyFavicon(d.faviconVer);
      if (d.eventName && d.eventName !== S.event) { S.event = d.eventName; $("#eventName").textContent = d.eventName; document.title = d.eventName; }
      if (S.detailId) loadDetail(S.detailId);
      render();
    },
    onItem: (d) => {
      S.offset = d.now - Date.now();
      const i = S.items.findIndex((x) => x.id === d.item.id);
      if (i >= 0) S.items[i] = d.item; else S.items.push(d.item);
      if (d.bid && S.detail && S.detail.item?.id === d.item.id) {
        // 상세 화면을 보고 있으면 서버에 다시 묻지 않고 새 입찰만 끼워 넣음
        S.detail.item = d.item;
        S.detail.bids = [d.bid, ...S.detail.bids].sort((a, b) => b.amount - a.amount || a.at - b.at);
        if (S.me && d.bid.pid === S.me.pid) rememberMine(d.item.id);
      }
      render();
    },
    onStatus: (ok) => { const el = $("#live"); el.classList.toggle("off", !ok); el.lastElementChild.textContent = ok ? "연결 원활" : "재연결 중"; },
  });
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
  setInterval(tick, 1000);
  render();
}
async function loadMy() {
  try { const r = await api("/api/my"); S.myWishes = r.wishes || {}; r.bidItems.forEach((id) => S.myItems.add(id)); } catch (e) {}
}
function rememberMine(itemId) {
  S.myItems.add(itemId);
  try { localStorage.setItem(LS + ".items", JSON.stringify([...S.myItems])); } catch (e) {}
}

/* ---------------- routing / render ---------------- */
const route = () => { const h = location.hash.slice(1); return h.startsWith("item-") ? { v: "item", id: h.slice(5) } : { v: "list" }; };

function render() {
  renderWho();
  const app = $("#app");
  if (!S.me) { renderLogin(app); return; }
  const r = route();
  if (r.v === "item") { if (S.detailId !== r.id) { S.detailId = r.id; S.detail = null; loadDetail(r.id); } renderItem(app, r.id); return; }
  S.detailId = null;
  renderList(app);
}
function renderWho() {
  const w = $("#who");
  w.innerHTML = S.me ? `<span>사번 ${esc(S.me.emp)}</span>${S.me.isAdmin ? `<a class="hbtn" href="/admin.html">관리자</a>` : ""}<button class="hbtn" id="logout">로그아웃</button>` : "";
  const b = $("#logout");
  if (b) b.onclick = async () => {
    if (!(await modal({ title: "로그아웃", body: "로그아웃할까요?\n입찰 내역은 그대로 남아 있습니다.", ok: "로그아웃" }))) return;
    S.me = null; saveMe(null); location.hash = ""; $("#app").dataset.view = ""; render();
  };
}

/* ---------------- login ---------------- */
function renderLogin(app) {
  if (app.dataset.view === "login") return;
  app.dataset.view = "login";
  app.innerHTML = `<div class="login"><form class="lcard" id="lf" novalidate>
    <img class="lg-logo" src="/logo.svg" alt="">
    <h2>경매 입장하기</h2>
    <p class="sub">임직원 기부 물품 경매에 참여하시려면<br>사번과 연락처를 입력해 주세요.</p>
    <label class="f" for="emp">사번 (6자리)</label>
    <input class="t" id="emp" inputmode="numeric" maxlength="6" placeholder="예) 123456" autocomplete="off">
    <label class="f" for="ph">휴대폰 번호</label>
    <input class="t" id="ph" inputmode="tel" maxlength="13" placeholder="010-0000-0000" autocomplete="tel">
    <label class="agree"><input type="checkbox" id="ag"><span>낙찰 안내 문자 발송을 위해 사번과 휴대폰 번호를 수집하며, 경매 종료 후 안내가 끝나면 삭제합니다. 번호는 경매 담당자만 볼 수 있습니다.</span></label>
    <button class="btn" style="width:100%" id="lgo">입장하기</button>
    <div class="msg err" id="lmsg"></div>
  </form></div>`;
  const ph = $("#ph"), emp = $("#emp");
  ph.addEventListener("input", () => { const d = digits(ph.value).slice(0, 11); ph.value = d.length > 7 ? d.replace(/(\d{3})(\d{4})(\d{0,4})/, "$1-$2-$3") : d.length > 3 ? d.replace(/(\d{3})(\d{0,4})/, "$1-$2") : d; });
  emp.addEventListener("input", () => (emp.value = digits(emp.value).slice(0, 6)));
  $("#lf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#lmsg"), e6 = emp.value.trim(), p = digits(ph.value);
    if (!/^\d{6}$/.test(e6)) { msg.textContent = "사번 6자리를 정확히 입력해 주세요."; emp.focus(); return; }
    if (!/^01[016789]\d{7,8}$/.test(p)) { msg.textContent = "휴대폰 번호를 정확히 입력해 주세요."; ph.focus(); return; }
    if (!$("#ag").checked) { msg.textContent = "개인정보 수집에 동의해 주세요."; return; }
    $("#lgo").disabled = true;
    try {
      const r = await api("/api/login", { method: "POST", body: JSON.stringify({ emp: e6, phone: p, agree: true }) });
      S.me = { token: r.token, emp: r.emp, pid: r.pid, isAdmin: !!r.isAdmin }; saveMe(S.me); await loadMy();
      app.dataset.view = ""; render(); toast("환영합니다! 경매에 참여해 보세요.");
    } catch (err) { msg.textContent = err.message; $("#lgo").disabled = false; }
  });
}

/* ---------------- list ---------------- */
function badge(it, s) {
  if (s.closed) return s.sold ? `<span class="badge b-done">낙찰완료</span>` : `<span class="badge b-none">유찰</span>`;
  if (s.pre) return wishOpen() ? `<span class="badge b-wish">희망가 접수중</span>` : `<span class="badge b-none">경매 전</span>`;
  if (it.extended) return `<span class="badge b-soon">🔥 연장전</span>`;
  if (s.left < 3600e3) return `<span class="badge b-soon">마감임박</span>`;
  return `<span class="badge b-live">진행중</span>`;
}
function renderList(app) {
  if (app.dataset.view !== "list") {
    app.dataset.view = "list";
    app.innerHTML = `<div class="wrap"><section class="hero"><h1>마음을 나누는 <em>연말 경매</em></h1><p>임직원이 기부한 물품을 경매로 나눕니다. 수익금은 전액 기부됩니다.</p>
      <div id="sched"></div><div class="stats" id="stats"></div><div class="filters" id="filters"></div></section><div class="grid" id="grid"></div></div>`;
  }
  const rows = S.items.map((it) => [it, st(it)]);
  $("#sched").innerHTML = schedBanner();
  const live = rows.filter(([, s]) => !s.closed && !s.pre).length;
  const total = rows.reduce((a, [it]) => a + (it.top ? it.top.amount : 0), 0);
  const bids = rows.reduce((a, [it]) => a + it.bidCount, 0);
  const myTop = rows.filter(([, s]) => s.mineTop).length;
  $("#stats").innerHTML = `<div class="stat"><b>${S.items.length}</b><span>전체 물품</span></div>${started() ? `<div class="stat"><b>${live}</b><span>진행중</span></div>` : `<div class="stat"><b>${rows.filter(([, s]) => s.myWish).length}</b><span>내가 희망가 남긴 물품</span></div>`}${S.me?.isAdmin ? `<div class="stat"><b>${bids}</b><span>총 입찰</span></div>` : ""}<div class="stat"><b>${total.toLocaleString("ko-KR")}</b><span>현재 모금액(원)</span></div>${myTop ? `<div class="stat hl"><b>${myTop}</b><span>내가 최고가인 물품</span></div>` : ""}`;
  const F = started() ? [["all", "전체"], ["live", "진행중"], ["mine", "내 입찰"], ["done", "종료"]] : [["all", "전체"], ["mine", "내 희망가"]];
  $("#filters").innerHTML = F.map(([k, l]) => `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${k}">${l}</button>`).join("");
  $$("#filters button").forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; renderList(app); }));
  const grid = $("#grid");
  if (!S.loaded) { grid.innerHTML = `<div class="center" style="grid-column:1/-1">불러오는 중…</div>`; grid.dataset.sig = ""; return; }
  const shown = rows.filter(([, s]) => S.filter === "all" || (S.filter === "live" && !s.closed && !s.pre) || (S.filter === "done" && s.closed) || (S.filter === "mine" && (s.mineIn || s.mineTop || (s.pre && s.myWish))));
  if (!S.items.length || !shown.length) {
    grid.dataset.sig = "";
    grid.innerHTML = `<div class="center" style="grid-column:1/-1">${S.items.length ? "해당하는 물품이 없습니다." : "아직 등록된 물품이 없습니다."}</div>`;
    return;
  }
  const sig = shown.map(([it]) => `${it.id}:${it.imgVer}`).join("|");
  if (grid.dataset.sig !== sig) {
    grid.dataset.sig = sig;
    grid.innerHTML = shown.map(([it]) => `<button class="card" data-id="${esc(it.id)}">
      <div class="thumb">${imgUrl(it) ? `<img alt="" loading="lazy" src="${imgUrl(it)}">` : GIFT_PH}<span class="no">No.${esc(it.no)}</span><span class="bslot"></span><div class="stamp hidden"><span></span></div></div>
      <div class="cbody"><div class="cname"></div><div class="tagslot"></div>
      <div class="prow"><div><div class="plabel"></div><div class="price"></div></div></div>
      <div class="meta"><span class="cnt"></span><span class="cd"></span></div></div></button>`).join("");
    $$(".card", grid).forEach((c) => (c.onclick = () => (location.hash = "item-" + c.dataset.id)));
  }
  for (const [it, s] of shown) {
    const c = grid.querySelector(`.card[data-id="${CSS.escape(it.id)}"]`); if (!c) continue;
    c.classList.toggle("closed", s.closed);
    $(".cname", c).textContent = it.name;
    $(".bslot", c).innerHTML = badge(it, s);
    const stamp = $(".stamp", c); stamp.classList.toggle("hidden", !s.closed); stamp.classList.toggle("gray", !s.sold);
    stamp.firstElementChild.textContent = s.sold ? "낙찰완료" : "유찰";
    $(".plabel", c).textContent = s.closed ? (s.sold ? "낙찰가" : "시작가") : it.top ? "현재 최고가" : "시작가";
    const pe = $(".price", c), p = it.top ? it.top.amount : it.start;
    pe.textContent = s.pre && !it.top && !it.start ? "추후 공개" : won(p); flashIfChanged(pe, "l:" + it.id, p);
    $(".cnt", c).textContent = s.pre ? `관심 ${it.wishCount}명` : `입찰 ${it.bidCount}건`;
    const cd = $(".cd", c); cd.dataset.end = it.endAt; updateCd(cd);
    $(".tagslot", c).innerHTML = s.pre ? (s.myWish ? `<span class="mine">내 희망가 ${won(s.myWish)}</span>` : "") : s.mineTop ? `<span class="mine">${s.closed ? "내가 낙찰" : "내가 최고가"}</span>` : s.mineIn && !s.closed ? `<span class="mine out">더 높은 입찰 발생</span>` : "";
  }
}
function flashIfChanged(el, key, v) {
  if (S.prevPrice[key] != null && S.prevPrice[key] !== v) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  S.prevPrice[key] = v;
}
function schedBanner() {
  const sc = S.schedule;
  if (!sc.startAt) return "";
  if (started()) return "";
  return `<div class="sched"><div><b>${wishOpen() ? "🎁 지금은 희망가 접수 기간이에요" : "⏳ 희망가 접수가 끝났어요"}</b><span>${wishOpen() ? `갖고 싶은 물품에 희망가를 남겨 주세요. 금액은 다른 사람에게 공개되지 않아요.${sc.wishEndAt ? ` · 접수 마감 ${fmtDTfull(sc.wishEndAt)}` : ""}` : "경매가 시작되면 바로 입찰할 수 있어요."}</span></div>
    <div class="sched-r"><span>경매 시작</span><b>${fmtDTfull(sc.startAt)}</b><span class="cd" data-start="${sc.startAt}"></span></div></div>`;
}
function updateCd(el) {
  if (el.dataset.start) { const l = Number(el.dataset.start) - now(); el.textContent = l > 0 ? countdown(l) + " 남음" : "시작!"; return; }
  if (!started() && el.dataset.end) { el.textContent = S.schedule.startAt ? `${fmtDT(S.schedule.startAt)} 시작` : ""; el.classList.remove("urgent"); return; }
  const left = Number(el.dataset.end) - now();
  if (left <= 0) { el.textContent = "경매 종료"; el.classList.remove("urgent"); return; }
  el.textContent = countdown(left) + " 남음"; el.classList.toggle("urgent", left < 3600e3);
}

/* ---------------- detail ---------------- */
let detailSeq = 0;
async function loadDetail(id) {
  const seq = ++detailSeq;
  try {
    const d = await api("/api/items/" + encodeURIComponent(id));
    if (seq !== detailSeq || S.detailId !== id) return;
    S.detail = d;
    if (S.me && d.bids.some((b) => b.pid === S.me.pid)) rememberMine(id);
    if (route().v === "item") renderItem($("#app"), id);
  } catch (e) {
    if (e.status === 404 && S.detailId === id) { S.detail = { missing: true }; renderItem($("#app"), id); }
  }
}
function renderItem(app, id) {
  const it = S.items.find((x) => x.id === id) || S.detail?.item;
  if (!it) {
    if (S.loaded && (S.detail?.missing || S.items.length)) {
      app.dataset.view = "missing";
      app.innerHTML = `<div class="wrap"><button class="back" id="back2">← 전체 목록</button><div class="center">물품을 찾을 수 없습니다.</div></div>`;
      $("#back2").onclick = () => (location.hash = "");
    }
    return;
  }
  const s = st(it);
  const view = `item:${id}:${it.imgVer}`;
  if (S.detail && S.detail.item?.id === id && S.detail.item.photoVer !== it.photoVer) loadDetail(id);
  if (app.dataset.view !== view) {
    app.dataset.view = view;
    app.innerHTML = `<div class="wrap"><button class="back" id="back">← 전체 목록</button>
    <div class="pdp">
      <div class="pdp-thumb"><div class="dimg">${imgUrl(it) ? `<img alt="" src="${imgUrl(it)}">` : GIFT_PH}<span class="no">No.${esc(it.no)}</span><span class="bslot"></span></div></div>
      <aside class="pdp-aside" id="aside">
        <div class="dtitle" id="dname"></div>
        <div style="color:var(--muted);font-size:13px" id="ddonor"></div>
        <div class="panel" style="margin-top:12px" id="bidPanel">
          <div class="plabel" id="dplabel"></div>
          <div class="dprice price" id="dprice"></div>
          <dl class="kv"><dt id="dstartRow">경매 시작</dt><dd id="dstartRow2"><b id="dstartAt"></b></dd><dt>시작가</dt><dd id="dstart"></dd><dt>마감</dt><dd id="dend"></dd><dt id="cdLabel">남은 시간</dt><dd><span class="cd" id="dcd"></span></dd></dl>
          <div class="note red hidden" id="extNote" style="margin:0 0 10px">🔥 <b>연장전!</b> 마감 직전 입찰이 들어와 시간이 늘어났어요. ${S.schedule.extendSeconds || 30}초 동안 새 입찰이 없으면 끝나요.</div>
          <div id="bidArea"></div>
        </div>
        <div class="hist"><h3>입찰 현황 <span id="hcount" style="color:var(--muted);font-weight:400"></span></h3><ol id="hist"></ol></div>
      </aside>
      <section class="pdp-detail">
        <h2 class="pdp-tab">상품 상세</h2>
        <div class="ddesc" id="ddesc"></div>
        <div class="dphotos" id="dphotos"></div>
      </section>
    </div></div>
    <div class="mbar" id="mbar"><div><div class="plabel" id="mlabel"></div><div class="mprice" id="mprice"></div></div><div class="spacer"></div><span class="cd" id="mcd"></span><button class="btn" id="mgo">입찰하기</button></div>`;
    $("#back").onclick = () => (location.hash = "");
    $("#mgo").onclick = () => { $("#bidPanel").scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => ($("#amt") || $("#wamt"))?.focus({ preventScroll: true }), 400); };
    if (window.IntersectionObserver) {
      S.panelVisible = false;
      new IntersectionObserver((es) => { S.panelVisible = es[0].isIntersecting; updateMbar(); }).observe($("#bidPanel"));
    }
  }
  renderPhotos(it);
  updateMbar();
  $("#dname").textContent = it.name;
  $("#ddonor").textContent = it.donor ? `기부: ${it.donor}` : "";
  $("#ddesc").textContent = it.description || "";
  $(".dimg .bslot").innerHTML = badge(it, s);
  $("#dplabel").textContent = s.closed ? (s.sold ? "낙찰가" : "유찰") : it.top ? "현재 최고가" : "시작가";
  const p = it.top ? it.top.amount : it.start;
  $("#dprice").textContent = s.pre && !it.top && !it.start ? "추후 공개" : won(p); flashIfChanged($("#dprice"), "d:" + it.id, p);
  $("#dstart").textContent = s.pre && !it.start ? "추후 공개" : won(it.start); 
  $("#dend").innerHTML = it.extended ? `<s style="color:var(--muted)">${esc(fmtDTfull(it.baseEndAt))}</s> → <b style="color:var(--red)">${esc(fmtDTs(it.endAt))} 🔥연장</b>` : esc(fmtDTfull(it.endAt));
  $("#dstartRow").classList.toggle("hidden", !s.pre); $("#dstartRow2").classList.toggle("hidden", !s.pre);
  if (s.pre) $("#dstartAt").textContent = fmtDTfull(S.schedule.startAt);
  const cd = $("#dcd"); cd.dataset.end = it.endAt; updateCd(cd);
  $("#cdLabel").textContent = s.pre ? "시작까지" : "남은 시간";
  if (s.pre) { cd.dataset.start = S.schedule.startAt; updateCd(cd); } else delete cd.dataset.start;
  $("#extNote").classList.toggle("hidden", !(it.extended && !s.closed));

  const bids = S.detail && S.detail.item?.id === id ? S.detail.bids : null;
  $(".hist h3").firstChild.textContent = s.pre ? "관심 현황 " : "입찰 현황 ";
  $("#hcount").textContent = s.pre ? "" : bids ? `${bids.length}건` : "";
  if (s.pre && !(bids && bids.length)) {
    $("#hist").innerHTML = `<li class="empty">${it.wishCount ? `<b>${it.wishCount}명</b>이 이 물품에 희망가를 남겼어요 👀` : "아직 희망가를 남긴 사람이 없어요."}</li>`;
  } else
  $("#hist").innerHTML = !bids ? `<li class="empty">불러오는 중…</li>` : bids.length
    ? bids.map((b, i) => `<li class="${i === 0 ? "top" : ""}"><span>${i === 0 ? (s.closed ? "🏆 " : "👑 ") : ""}${S.me && b.pid === S.me.pid ? `<b>나</b> (${esc(b.emp)})` : esc(b.emp)}</span><span>${won(b.amount)}</span><span style="color:var(--muted)">${fmtDT(b.at)}</span></li>`).join("")
    : `<li class="empty">첫 입찰자가 되어 보세요!</li>`;

  const area = $("#bidArea");
  if (s.pre) { renderWish(area, it, s); return; }
  if (s.closed) {
    const mode = "closed:" + (it.top ? it.top.pid : "") + ":" + s.mineTop;
    if (area.dataset.mode !== mode) {
      area.dataset.mode = mode;
      area.innerHTML = !s.sold
        ? `<div class="closedbox none"><b>경매 종료 · 유찰</b><div style="font-size:13px;margin-top:4px;opacity:.85">입찰자가 없어 유찰되었습니다.</div></div>`
        : s.mineTop
          ? `<div class="closedbox win"><b>♥ 축하합니다! 낙찰되셨습니다.</b><div style="font-size:13px;margin-top:4px">낙찰가 ${won(it.top.amount)} · 입력하신 휴대폰 번호로 수령 안내 문자를 드립니다.</div></div>`
          : `<div class="closedbox"><b>경매 종료 · 낙찰완료</b><div style="font-size:13px;margin-top:4px;opacity:.85">낙찰자 ${esc(it.top.emp)} · ${won(it.top.amount)}<br>더 이상 입찰할 수 없습니다.</div></div>`;
    }
    return;
  }
  const RAISES = it.raises && it.raises.length ? it.raises : [1000, 3000, 5000, 10000];
  const rsig = "open:" + RAISES.join(",");
  if (area.dataset.mode !== rsig) {
    area.dataset.mode = rsig;
    area.innerHTML = `<div id="mystate"></div>
      <div class="tapnote">버튼을 누르면 <b>바로 입찰</b>돼요 (취소 불가)</div>
      <button class="btn tapfirst hidden" id="tapStart"></button>
      <div class="taps" id="taps">${RAISES.map((r) => `<button class="tap" data-r="${r}"><b>${raiseLabel(r)}</b></button>`).join("")}</div>
      <div class="msg" id="bmsg"></div>`;
    $$("#taps .tap").forEach((b) => (b.onclick = () => doBid(id, Number(b.dataset.amt))));
    $("#tapStart").onclick = () => doBid(id, Number($("#tapStart").dataset.amt));
  }
  const base = it.top ? it.top.amount : it.start;
  const fs = $("#tapStart");
  fs.classList.toggle("hidden", !!it.top);
  if (!it.top) { fs.dataset.amt = it.minNext; fs.textContent = `시작가 ${won(it.minNext)}에 첫 입찰`; }
  $$("#taps .tap").forEach((b) => {
    const r = Number(b.dataset.r), amt = base + r;
    const ok = amt >= it.minNext;
    b.dataset.amt = amt;
    b.disabled = S.busy || s.mineTop || !ok;
  });
  fs.disabled = S.busy || s.mineTop;
  if (!s.mineTop && $("#bmsg").classList.contains("ok")) { $("#bmsg").className = "msg"; $("#bmsg").textContent = ""; }
  $("#mystate").innerHTML = s.mineTop ? `<div class="note" style="margin-top:0">현재 회원님이 최고가 입찰자입니다. 다른 분이 올리면 다시 입찰할 수 있어요.</div>`
    : s.mineIn ? `<div class="note red" style="margin-top:0">다른 분이 더 높은 금액으로 입찰했습니다!</div>` : "";
}

function renderPhotos(it) {
  const box = $("#dphotos"); if (!box) return;
  const ids = S.detail && S.detail.item?.id === it.id ? S.detail.photos || [] : null;
  const sig = ids ? ids.join(",") : "loading";
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = ids === null ? "" : ids.length
    ? ids.map((pid) => `<img alt="상세 사진" loading="lazy" src="/api/photo/${pid}">`).join("")
    : (it.description ? "" : `<div class="center" style="padding:40px 0">등록된 상세 사진이 없습니다.</div>`);
}
function updateMbar() {
  const bar = $("#mbar"); if (!bar) return;
  const it = S.items.find((x) => x.id === S.detailId); if (!it) return;
  const s = st(it);
  bar.classList.toggle("show", !S.panelVisible);
  $("#mlabel").textContent = s.closed ? (s.sold ? "낙찰가" : "유찰") : it.top ? "현재 최고가" : "시작가";
  $("#mprice").textContent = won(it.top ? it.top.amount : it.start);
  const cd = $("#mcd"); cd.dataset.end = it.endAt; updateCd(cd);
  const b = $("#mgo");
  b.textContent = s.pre ? (wishOpen() ? (s.myWish ? "희망가 수정" : "희망가 남기기") : "경매 전") : s.closed ? (s.mineTop ? "♥ 낙찰" : "경매 종료") : s.mineTop ? "내가 최고가" : "입찰하기";
  b.disabled = s.closed || (s.pre && !wishOpen());
  if (s.pre) { $("#mlabel").textContent = "경매 시작"; $("#mprice").textContent = fmtDT(S.schedule.startAt); $("#mcd").dataset.start = S.schedule.startAt; } else delete $("#mcd").dataset.start;
}

function raiseLabel(v) {
  v = Number(v);
  if (v >= 10000 && v % 1000 === 0) return `+${(v / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}만원`;
  if (v >= 1000 && v % 100 === 0) return `+${(v / 1000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}천원`;
  return `+${v.toLocaleString("ko-KR")}원`;
}
function renderWish(area, it, s) {
  const open = wishOpen();
  const mode = "wish:" + open + ":" + (s.myWish || "");
  if (area.dataset.mode === mode) return;
  area.dataset.mode = mode;
  if (!open) {
    area.innerHTML = `<div class="closedbox none"><b>⏳ 희망가 접수가 끝났어요</b><div style="font-size:13px;margin-top:4px;opacity:.9">${esc(fmtDTfull(S.schedule.startAt))}에 경매가 시작되면 입찰할 수 있어요.${s.myWish ? `<br>내가 남긴 희망가: ${won(s.myWish)}` : ""}</div></div>`;
    return;
  }
  area.innerHTML = `<div class="wishbox">
    <b>🎁 희망가 남기기</b>
    <p>이 물품, 얼마면 사고 싶으세요? 남긴 금액은 <b>다른 사람에게 공개되지 않고</b> 경매 시작가를 정하는 데 참고만 해요. 구매 약속이 아니니 부담 없이 남겨 주세요.</p>
    ${s.myWish ? `<div class="mywish">내 희망가 <b>${won(s.myWish)}</b></div>` : ""}
    <div class="bidbox"><input id="wamt" inputmode="numeric" autocomplete="off" placeholder="예) 30,000" aria-label="희망가" value="${s.myWish ? Number(s.myWish).toLocaleString("ko-KR") : ""}"><button class="btn" id="wbtn">${s.myWish ? "수정하기" : "남기기"}</button></div>
    ${s.myWish ? `<button class="btn ghost sm" id="wdel" style="margin-top:8px">희망가 취소</button>` : ""}
    <div class="msg" id="wmsg"></div></div>`;
  const w = $("#wamt");
  w.addEventListener("input", () => { const d = digits(w.value); w.value = d ? Number(d).toLocaleString("ko-KR") : ""; });
  w.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#wbtn").click(); });
  const send = async (amount) => {
    const m = $("#wmsg");
    try {
      await api("/api/wish", { method: "POST", body: JSON.stringify({ itemId: it.id, amount }) });
      if (amount) S.myWishes[it.id] = amount; else delete S.myWishes[it.id];
      toast(amount ? `희망가 ${won(amount)}을 남겼어요` : "희망가를 취소했어요"); area.dataset.mode = ""; render();
    } catch (e) { m.className = "msg err"; m.textContent = e.message; }
  };
  $("#wbtn").onclick = () => { const a = Number(digits(w.value)); if (!a) { $("#wmsg").className = "msg err"; $("#wmsg").textContent = "금액을 입력해 주세요."; return; } send(a); };
  if ($("#wdel")) $("#wdel").onclick = () => send(null);
}

async function doBid(id, amount) {
  const it = S.items.find((x) => x.id === id); if (!it || S.busy || !amount) return;
  const msg = $("#bmsg"); msg.className = "msg";
  S.busy = true; render();
  try {
    await api("/api/bid", { method: "POST", body: JSON.stringify({ itemId: id, amount }) });
    rememberMine(id);
    msg.className = "msg ok"; msg.textContent = `${won(amount)} 입찰 완료!`; toast(`${won(amount)} 입찰!`);
    if (navigator.vibrate) try { navigator.vibrate(40); } catch (e) {}
  } catch (e) {
    msg.className = "msg err";
    // 그 사이 다른 사람이 먼저 올린 경우: 보던 가격보다 높게 자동으로 넣지 않고 다시 누르게 함
    msg.textContent = e.data?.code === "low" ? `그 사이 다른 입찰이 먼저 들어왔어요. 현재가를 확인하고 다시 눌러 주세요.` : e.message;
  } finally {
    S.busy = false; render();
  }
}

/* ---------------- tick ---------------- */
let flipSig = "";
function tick() {
  $$(".cd[data-end],.cd[data-start]").forEach(updateCd);
  const sig = (started() ? "S" : "P") + (wishOpen() ? "W" : "") + S.items.map((it) => { const l = it.endAt - now(); return l <= 0 ? "c" : l < 3600e3 ? "h" : "o"; }).join("");
  if (sig !== flipSig) { flipSig = sig; render(); }
}

boot();
