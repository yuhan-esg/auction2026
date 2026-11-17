import { $, $$, esc, won, fmtDT, fmtDTs, fmtDTfull, toLocalInput, digits, toast, modal, moneyInput, imgUrl, connectLive, applyFavicon } from "./common.js";

// 참여자 화면과 같은 로그인 정보를 씁니다 (같은 기기라면 한 번만 로그인)
const LS = "auction.session.v1";
const A = { me: null, ov: null, tab: "items", form: null, tpl: null };
try { A.me = JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) {}
const saveMe = (v) => { try { v ? localStorage.setItem(LS, JSON.stringify(v)) : localStorage.removeItem(LS); } catch (e) {} };

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, cache: "no-store", headers: { "content-type": "application/json", authorization: "Bearer " + (A.me?.token || ""), ...(opts.headers || {}) } });
  if (r.status === 401) { A.me = null; saveMe(null); renderLogin(); throw Object.assign(new Error("로그인이 필요합니다."), { status: 401 }); }
  if (r.status === 403) { renderLogin("관리자로 지정된 계정이 아닙니다. 지정된 사번과 휴대폰 번호로 로그인해 주세요."); throw Object.assign(new Error("권한 없음"), { status: 403 }); }
  const data = r.headers.get("content-type")?.includes("json") ? await r.json().catch(() => ({})) : await r.blob();
  if (!r.ok) throw Object.assign(new Error(data.error || "요청에 실패했습니다."), { status: r.status, data });
  return data;
}

/* ---------------- login ---------------- */
function renderLogin(msg = "") {
  $("#alogout").classList.toggle("hidden", !A.me);
  $("#app").innerHTML = `<div class="login"><form class="lcard" id="af" novalidate><h2>관리자 로그인</h2>
    <p class="sub">관리자로 지정된 사번과 휴대폰 번호로 로그인하세요.</p>
    <label class="f" for="aemp">사번 (6자리)</label><input class="t" id="aemp" inputmode="numeric" maxlength="6" autocomplete="off">
    <label class="f" for="aph">휴대폰 번호</label><input class="t" id="aph" inputmode="tel" maxlength="13" placeholder="010-0000-0000">
    <button class="btn" style="width:100%;margin-top:18px">들어가기</button><div class="msg err" id="amsg">${esc(msg)}</div></form></div>`;
  $("#aemp").focus();
  $("#aemp").addEventListener("input", (e) => (e.target.value = digits(e.target.value).slice(0, 6)));
  $("#af").addEventListener("submit", async (e) => {
    e.preventDefault();
    const emp = $("#aemp").value, phone = digits($("#aph").value);
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emp, phone, agree: true, admin: true }) });
      const d = await r.json();
      if (!r.ok) { $("#amsg").textContent = d.error || "로그인에 실패했습니다."; return; }
      if (!d.isAdmin) { $("#amsg").textContent = "관리자 정보가 맞지 않습니다."; return; }
      A.me = { token: d.token, emp: d.emp, pid: d.pid, isAdmin: true }; saveMe(A.me);
      await load(); start();
    } catch (er) { if (er.status !== 403) $("#amsg").textContent = "로그인에 실패했습니다."; }
  });
}

let started = false, reloadT;
function start() {
  $("#alogout").classList.remove("hidden");
  $("#alogout").textContent = `로그아웃 (${A.me.emp})`;
  $("#alogout").onclick = async () => { if (await modal({ title: "로그아웃", body: "이 기기에서 로그아웃합니다.\n경매장 화면도 함께 로그아웃됩니다.", ok: "로그아웃" })) { saveMe(null); location.reload(); } };
  renderShell();
  if (started) return; started = true;
  connectLive({
    onState: () => { clearTimeout(reloadT); reloadT = setTimeout(() => load().then(refresh).catch(() => {}), 250); },
    onStatus: (ok) => { const el = $("#live"); el.classList.toggle("off", !ok); el.lastElementChild.textContent = ok ? "연결 원활" : "재연결 중"; },
  });
  setInterval(() => $$(".cd[data-end]").forEach((el) => { const l = Number(el.dataset.end) - Date.now(); el.textContent = l > 0 ? "진행중" : "종료"; }), 1000);
}
async function load() { A.ov = await api("/api/admin/overview"); document.title = `${A.ov.eventName} · 관리자`; applyFavicon(A.ov.faviconVer && A.ov.hasFavicon ? A.ov.faviconVer : 0); }

/* ---------------- shell ---------------- */
const TABS = [["items", "물품 관리"], ["data", "데이터 관리"], ["sms", "문자 발송"], ["log", "작업 기록"], ["etc", "기타"]];
function renderShell() {
  const ov = A.ov;
  $("#app").innerHTML = `<div class="wrap" style="padding-bottom:60px">
    ${ov.smsMode !== "live" ? `<div class="note" style="margin-top:18px"><b>문자 테스트 모드</b> — 낙찰 문자는 실제로 발송되지 않고 ‘문자 발송’ 탭에 미리보기로만 기록됩니다.</div>` : `<div class="note red" style="margin-top:18px"><b>문자 실제 발송 모드</b> — 경매가 끝나면 낙찰자에게 실제로 문자가 발송됩니다.</div>`}
    <div class="stats" id="astats"></div>
    <div class="atabs">${TABS.map(([k, l]) => `<button class="chip ${A.tab === k ? "on" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
    <div id="abody"></div></div>`;
  $$("[data-t]").forEach((b) => (b.onclick = () => { A.tab = b.dataset.t; renderShell(); }));
  if (A.tab === "items") buildItems();
  if (A.tab === "sms") buildSms();
  if (A.tab === "etc") buildEtc();
  if (A.tab === "data") buildRoster();
  if (A.tab === "log") buildLog();
  refresh();
}
function refresh() {
  if (!A.ov || !$("#astats")) return;
  const ov = A.ov, its = ov.items;
  const sold = its.filter((i) => i.status === "sold");
  $("#astats").innerHTML = `<div class="stat"><b>${its.length}</b><span>물품</span></div><div class="stat"><b>${its.filter((i) => i.status === "live").length}</b><span>진행중</span></div><div class="stat"><b>${ov.stats.participants}</b><span>입장한 임직원</span></div><div class="stat"><b>${ov.stats.bids}</b><span>총 입찰</span></div><div class="stat"><b>${its.reduce((a, i) => a + (i.top ? i.top.amount : 0), 0).toLocaleString("ko-KR")}</b><span>현재 모금액(원)</span></div><div class="stat hl"><b>${sold.reduce((a, i) => a + i.top.amount, 0).toLocaleString("ko-KR")}</b><span>낙찰 확정액(원)</span></div>`;
  if (A.tab === "items") refreshItems();
  if (A.tab === "data") loadRoster();
  if (A.tab === "sms") refreshSmsLog();
  if (A.tab === "log") buildLog();
}
const statusText = (i) => (i.status === "sold" ? "낙찰완료" : i.status === "unsold" ? "유찰" : "진행중");

/* ---------------- items ---------------- */
function defaultEnd() { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(18, 0, 0, 0); return d.getTime(); }
function nextNo() { return (A.ov.items.reduce((m, x) => Math.max(m, x.no || 0), 0) || 0) + 1; }
function buildItems() {
  const sc = A.ov.schedule || {};
  $("#abody").innerHTML = `
  <div class="panel" style="margin-bottom:16px"><h3 style="margin:0 0 4px">경매 일정</h3>
    <p style="font-size:13px;color:var(--muted);margin:0 0 6px">경매 시작 전까지는 입찰이 막히고 <b>희망가 접수</b>만 받아요.<br>시작 시각을 비워 두면 바로 입찰할 수 있어요.</p>
    <div class="row" style="align-items:flex-end;gap:18px">
      <div style="flex:1;min-width:260px"><label class="f" for="s_name" style="margin-top:4px">행사 이름 <span style="font-weight:400;color:var(--muted)">(브라우저 탭, 화면 제목, 문자의 {행사명}에 쓰여요)</span></label><input class="t" id="s_name" maxlength="40" value="${esc(A.ov.eventName)}"></div>
      <div><label class="f">탭 아이콘</label><div class="row"><img id="s_icon" src="${A.ov.hasFavicon ? `/api/favicon?v=${A.ov.faviconVer}` : "/favicon.svg"}" alt="" style="width:36px;height:36px;border-radius:8px;border:1px solid var(--line);background:#fff"><label class="btn ghost sm" style="cursor:pointer">이미지 바꾸기<input type="file" id="s_iconf" accept="image/*" hidden></label>${A.ov.hasFavicon ? `<button class="btn ghost sm" id="s_iconx">기본 아이콘으로</button>` : ""}</div></div>
    </div>
    <div class="formgrid" style="grid-template-columns:1fr 1fr 1fr">
      <div><label class="f" for="s_wish">희망가 접수 마감 <span style="font-weight:400;color:var(--muted)">(비우면 시작 전까지)</span></label><input class="t" type="datetime-local" id="s_wish" value="${sc.wishEndAt ? toLocalInput(sc.wishEndAt) : ""}"></div>
      <div><label class="f" for="s_start">경매 시작 시각</label><input class="t" type="datetime-local" id="s_start" value="${sc.startAt ? toLocalInput(sc.startAt) : ""}"></div>
      <div><label class="f" for="s_ext">마감 직전 연장 (초)</label><input class="t" id="s_ext" inputmode="numeric" value="${sc.extendSeconds ?? 30}"></div>
    </div>
    <p style="font-size:12.5px;color:var(--muted);margin:8px 0 0" id="s_desc"></p>
    <label class="f" for="s_notice">참여자 화면 입찰 안내 <span style="font-weight:400;color:var(--muted)">(목록 화면 위에 보여요 · 한 줄에 하나씩 · **이렇게** 감싸면 굵게 · 비우면 숨김)</span></label>
    <textarea class="t" id="s_notice" rows="4" maxlength="1500">${esc(A.ov.notice || "")}</textarea>
    <div class="row" style="margin-top:6px"><button type="button" class="btn ghost sm" id="s_noticeReset">기본 안내로</button><span style="font-size:12px;color:var(--muted)">예) 담당자: 총무팀 홍길동 (내선 1234)</span></div>
    <div class="row" style="margin-top:10px"><button class="btn sm" id="s_save">일정 저장</button><span class="msg" id="s_msg"></span></div>
  </div>`;
  $("#abody").insertAdjacentHTML("beforeend", `
  <div class="panel" id="formPanel"><h3 style="margin:0 0 6px" id="ftitle">물품 등록</h3>
    <form id="ifm" class="formgrid" novalidate>
      <div><label class="f" for="f_no">번호</label><input class="t" id="f_no" inputmode="numeric"></div>
      <div><label class="f" for="f_name">물품명</label><input class="t" id="f_name" maxlength="100"></div>
      <div><label class="f" for="f_start">시작가 (원) <span style="font-weight:400;color:var(--muted)">0 = 추후 공개</span></label><input class="t" id="f_start" inputmode="numeric"></div>
      <div><label class="f" for="f_r0">입찰 버튼 금액 4개 (원) <span style="font-weight:400;color:var(--muted)">누르면 현재가에 이만큼 더해서 바로 입찰</span></label>
        <div class="raisegrid">${[0, 1, 2, 3].map((i) => `<div><input class="t" id="f_r${i}" inputmode="numeric" aria-label="버튼 ${i + 1}"><span class="rprev" id="f_rp${i}"></span></div>`).join("")}</div>
        <div class="row" style="margin-top:6px">${[[1000, 3000, 5000, 10000], [5000, 10000, 30000, 50000], [10000, 30000, 50000, 100000]].map((p) => `<button type="button" class="chip" data-preset="${p.join(",")}">${p.map(raiseLabel).join(" · ")}</button>`).join("")}</div>
        <div class="rwarn hidden" id="f_rwarn"><span></span><button type="button" class="btn sm" id="f_rrec">추천 금액 넣기</button></div></div>
      <div><label class="f" for="f_end">경매 종료 시각</label><input class="t" type="datetime-local" id="f_end"></div>
      <div><label class="f" for="f_donor">기부자 (선택)</label><input class="t" id="f_donor" maxlength="60" placeholder="예) 경영지원팀 홍길동"></div>
      <div class="full"><label class="f" for="f_desc">상세 설명</label><textarea class="t" id="f_desc" rows="4" maxlength="3000" placeholder="상태, 구성품, 사이즈 등"></textarea></div>
      <div class="full"><label class="f" for="f_img">대표 사진 (썸네일 1장)</label><input type="file" id="f_img" accept="image/*"><img id="f_prev" class="imgprev hidden" alt=""><button type="button" class="btn ghost sm hidden" id="f_rmimg" style="margin-top:6px">사진 삭제</button></div>
      <div class="full"><label class="f" for="f_photos">상세 사진 (여러 장 선택 가능 · 상세페이지에 위에서부터 순서대로 표시 · 최대 30장)</label><input type="file" id="f_photos" accept="image/*" multiple><div class="plist" id="f_plist"></div></div>
      <div class="full row" style="margin-top:14px"><button class="btn" id="f_save">등록하기</button><button type="button" class="btn ghost hidden" id="f_cancel">취소</button><span class="msg" id="f_msg"></span></div>
    </form></div>
  <div class="panel" style="margin-top:16px">
    <div class="row" style="justify-content:space-between;margin-bottom:10px"><h3 style="margin:0">등록된 물품</h3>
      <div class="row"><input class="t" type="datetime-local" id="bulkEnd" style="width:auto;padding:6px 9px;font-size:13px"><button class="btn ghost sm" id="bulkBtn">전체 종료 시각 일괄 변경</button></div></div>
    <div class="tscroll"><table class="t"><thead><tr><th>No.</th><th>사진</th><th>물품명</th><th>희망가</th><th>시작가</th><th>현재가</th><th>입찰</th><th>종료</th><th>상태</th><th></th></tr></thead><tbody id="itbody"></tbody></table></div>
  </div>`);
  $("#s_iconf").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const url = await new Promise((res, rej) => { const img = new Image(), u = URL.createObjectURL(f); img.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d"); const s = Math.min(img.width, img.height); g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128); URL.revokeObjectURL(u); res(c.toDataURL("image/png")); }; img.onerror = rej; img.src = u; });
      await api("/api/admin/schedule", { method: "PUT", body: JSON.stringify({ favicon: url }) });
      toast("탭 아이콘을 바꿨어요"); await load(); renderShell();
    } catch (er) { toast("아이콘을 바꾸지 못했어요"); }
  });
  if ($("#s_iconx")) $("#s_iconx").onclick = async () => { await api("/api/admin/schedule", { method: "PUT", body: JSON.stringify({ favicon: "" }) }); toast("기본 아이콘으로 돌렸어요"); await load(); renderShell(); };
  $("#s_noticeReset").onclick = () => { $("#s_notice").value = A.ov.defaultNotice; };
  const ext = $("#s_ext");
  const desc = () => { const n = Number(digits(ext.value)) || 0; $("#s_desc").textContent = n ? `마감 ${n}초 안에 입찰이 들어오면 남은 시간을 ${n}초로 다시 맞춥니다.\n횟수 제한 없이, 마지막 입찰 뒤 ${n}초 동안 아무도 안 부르면 끝나요.` : "연장을 끕니다.\n정해진 마감 시각에 바로 끝나요."; };
  ext.addEventListener("input", () => { ext.value = digits(ext.value).slice(0, 3); desc(); }); desc();
  $("#s_save").onclick = async () => {
    const v = (id) => ($("#" + id).value ? new Date($("#" + id).value).getTime() : null);
    const startAt = v("s_start"), wishEndAt = v("s_wish");
    const m = $("#s_msg");
    if (wishEndAt && startAt && wishEndAt > startAt) { m.className = "msg err"; m.textContent = "희망가 마감은 경매 시작보다 앞이어야 해요."; return; }
    const early = A.ov.items.filter((i) => startAt && i.endAt <= startAt);
    if (early.length && !(await modal({ title: "확인해 주세요", body: `종료 시각이 경매 시작보다 빠른 물품이 ${early.length}개 있어요.\n(예: No.${early[0].no} ${early[0].name})\n물품별 종료 시각도 확인해 주세요.`, ok: "그래도 저장" }))) return;
    try { await api("/api/admin/schedule", { method: "PUT", body: JSON.stringify({ startAt, wishEndAt, extendSeconds: Number(digits(ext.value)) || 0, eventName: $("#s_name").value, notice: $("#s_notice").value }) }); m.className = "msg ok"; m.textContent = "저장되었습니다"; await load(); refresh(); } catch (e) { m.className = "msg err"; m.textContent = e.message; }
  };
  ["f_start", "f_r0", "f_r1", "f_r2", "f_r3"].forEach((i) => moneyInput($("#" + i)));
  [0, 1, 2, 3].forEach((i) => $("#f_r" + i).addEventListener("input", previewRaises));
  $("#f_start").addEventListener("input", previewRaises);
  $$("[data-preset]").forEach((b) => (b.onclick = () => setRaises(b.dataset.preset.split(",").map(Number))));
  $("#bulkEnd").value = toLocalInput(defaultEnd());
  resetForm();
  $("#f_img").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { A.form.img = await compress(f); A.form.imgChanged = true; showPrev(A.form.img); } catch (er) { setMsg("이미지를 읽지 못했습니다.", true); }
  });
  $("#f_photos").addEventListener("change", async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    for (const f of files) {
      if (A.form.photos.length >= 30) { setMsg("상세 사진은 30장까지입니다.", true); break; }
      try { const d = await compress(f, true); A.form.photos.push({ src: d, dataUrl: d }); A.form.photosChanged = true; renderPlist(); } catch (er) { setMsg("이미지를 읽지 못했습니다: " + f.name, true); }
    }
  });
  $("#f_rmimg").onclick = () => { A.form.img = null; A.form.imgChanged = true; showPrev(null); $("#f_img").value = ""; };
  $("#f_cancel").onclick = resetForm;
  $("#ifm").addEventListener("submit", saveItem);
  $("#bulkBtn").onclick = async () => {
    const v = $("#bulkEnd").value; if (!v) return;
    const ms = new Date(v).getTime();
    if (!(await modal({ title: "종료 시각 일괄 변경", body: `모든 물품(${A.ov.items.length}개)의 종료 시각을\n${fmtDTfull(ms)}(으)로 바꿉니다.${ms > Date.now() ? "\n이미 끝난 물품도 다시 진행중이 됩니다." : ""}`, ok: "변경" }))) return;
    try { await api("/api/admin/bulk-end", { method: "POST", body: JSON.stringify({ endAt: ms }) }); toast("변경되었습니다"); } catch (e) { toast(e.message); }
  };
}
const setMsg = (t, bad) => { const m = $("#f_msg"); m.className = "msg " + (bad ? "err" : "ok"); m.textContent = t; };
function showPrev(src) { const p = $("#f_prev"); p.classList.toggle("hidden", !src); $("#f_rmimg").classList.toggle("hidden", !src); if (src) p.src = src; }
function renderPlist() {
  const box = $("#f_plist"); if (!box) return;
  const L = A.form.photos;
  box.innerHTML = L.map((p, i) => `<div class="pitem"><img src="${esc(p.src)}" alt=""><span class="pnum">${i + 1}</span><div class="pbtns"><button type="button" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="위로">▲</button><button type="button" data-dn="${i}" ${i === L.length - 1 ? "disabled" : ""} aria-label="아래로">▼</button><button type="button" data-rm="${i}" aria-label="삭제">✕</button></div></div>`).join("")
    || `<div style="font-size:13px;color:var(--muted);padding:6px 0">아직 상세 사진이 없습니다.</div>`;
  const mv = (i, j) => { [L[i], L[j]] = [L[j], L[i]]; A.form.photosChanged = true; renderPlist(); };
  $$("[data-up]", box).forEach((b) => (b.onclick = () => mv(+b.dataset.up, +b.dataset.up - 1)));
  $$("[data-dn]", box).forEach((b) => (b.onclick = () => mv(+b.dataset.dn, +b.dataset.dn + 1)));
  $$("[data-rm]", box).forEach((b) => (b.onclick = () => { const [r] = L.splice(+b.dataset.rm, 1); if (r.id) A.form.removed.push(r.id); A.form.photosChanged = true; renderPlist(); }));
}
function raiseLabel(v) {
  v = Number(v);
  if (v >= 10000 && v % 1000 === 0) return `+${(v / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}만원`;
  if (v >= 1000 && v % 100 === 0) return `+${(v / 1000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}천원`;
  return `+${v.toLocaleString("ko-KR")}원`;
}
function setRaises(arr) { [0, 1, 2, 3].forEach((i) => ($("#f_r" + i).value = Number(arr[i] || 0).toLocaleString("ko-KR"))); previewRaises(); }
// 시작가 기준 추천 버튼 금액: 약 3%·5%·10%·20%를 보기 좋은 단위로 반올림
function niceRound(v) { const u = v >= 100000 ? 10000 : v >= 10000 ? 5000 : 1000; return Math.max(1000, Math.round(v / u) * u); }
function recommendRaises(start) {
  const r = [0.03, 0.05, 0.1, 0.2].map((k) => niceRound(start * k));
  for (let i = 1; i < 4; i++) if (r[i] <= r[i - 1]) r[i] = niceRound(r[i - 1] * 1.8);
  return r;
}
function previewRaises() {
  [0, 1, 2, 3].forEach((i) => { const v = Number(digits($("#f_r" + i).value)); $("#f_rp" + i).textContent = v ? raiseLabel(v) : ""; });
  const start = Number(digits($("#f_start")?.value || "")), vals = [0, 1, 2, 3].map((i) => Number(digits($("#f_r" + i).value))).filter(Boolean);
  const w = $("#f_rwarn"); if (!w) return;
  const low = start >= 20000 && vals.length && Math.min(...vals) < start * 0.03;
  w.classList.toggle("hidden", !low);
  if (low) {
    const rec = recommendRaises(start);
    w.firstElementChild.textContent = `가장 작은 버튼(${raiseLabel(Math.min(...vals))})이 시작가의 3%보다 작아요.\n아주 작은 차이로 낙찰이 갈리면 서운해하는 분이 생길 수 있어요.\n추천: ${rec.map(raiseLabel).join(" · ")}`;
    $("#f_rrec").onclick = () => setRaises(rec);
  }
}
function resetForm() {
  A.form = { id: null, img: null, imgChanged: false, photos: [], removed: [], photosChanged: false };
  renderPlist();
  $("#ifm").reset(); $("#ftitle").textContent = "물품 등록"; $("#f_save").textContent = "등록하기"; $("#f_cancel").classList.add("hidden"); showPrev(null);
  $("#f_no").value = nextNo(); $("#f_start").value = "10,000"; setRaises([1000, 3000, 5000, 10000]); $("#f_end").value = toLocalInput(defaultEnd()); setMsg("");
}
async function editItem(id) {
  const it = A.ov.items.find((x) => x.id === id); if (!it) return;
  A.form = { id, img: imgUrl(it) || null, imgChanged: false, photos: [], removed: [], photosChanged: false };
  renderPlist();
  fetch("/api/items/" + encodeURIComponent(id), { cache: "no-store" }).then((r) => r.json()).then((d) => {
    if (A.form.id !== id) return;
    A.form.photos = (d.photos || []).map((pid) => ({ id: pid, src: "/api/photo/" + pid })); renderPlist();
  }).catch(() => {});
  $("#f_no").value = it.no; $("#f_name").value = it.name; $("#f_start").value = Number(it.start).toLocaleString("ko-KR"); setRaises(it.raises);
  $("#f_end").value = toLocalInput(it.endAt); $("#f_donor").value = it.donor || ""; $("#f_desc").value = it.description || ""; showPrev(A.form.img);
  $("#ftitle").textContent = `No.${it.no} 수정`; $("#f_save").textContent = "저장하기"; $("#f_cancel").classList.remove("hidden"); setMsg("");
  $("#formPanel").scrollIntoView({ behavior: "smooth" });
}
async function saveItem(e) {
  e.preventDefault();
  const n = (id) => Number(digits($("#" + id).value));
  const data = { no: n("f_no"), name: $("#f_name").value.trim(), start: n("f_start"), raises: [0, 1, 2, 3].map((i) => n("f_r" + i)), endAt: new Date($("#f_end").value).getTime(), donor: $("#f_donor").value.trim(), description: $("#f_desc").value.trim() };
  if (!data.no) return setMsg("번호를 입력해 주세요.", true);
  if (!data.name) return setMsg("물품명을 입력해 주세요.", true);
  if (data.raises.some((x) => !x)) return setMsg("입찰 버튼 금액 4개를 모두 입력해 주세요.", true);
  if (!data.endAt) return setMsg("종료 시각을 입력해 주세요.", true);
  const editing = A.form.id;
  if (editing) {
    const old = A.ov.items.find((x) => x.id === editing);
    if (old && old.bidCount && (data.start !== old.start || data.raises.join() !== (old.raises || []).join()) &&
      !(await modal({ title: "입찰이 있는 물품입니다", body: `이미 입찰 ${old.bidCount}건이 있습니다.\n시작가·버튼 금액을 바꾸면 다음 입찰 금액이 달라집니다.`, ok: "그래도 저장" }))) return;
  }
  $("#f_save").disabled = true;
  try {
    let id = editing;
    if (editing) await api("/api/admin/items/" + editing, { method: "PUT", body: JSON.stringify(data) });
    else id = (await api("/api/admin/items", { method: "POST", body: JSON.stringify(data) })).id;
    if (A.form.imgChanged) {
      if (A.form.img) await api(`/api/admin/items/${id}/image`, { method: "PUT", body: JSON.stringify({ dataUrl: A.form.img }) });
      else if (editing) await api(`/api/admin/items/${id}/image`, { method: "DELETE" });
    }
    if (A.form.photosChanged) {
      for (const pid of A.form.removed) await api("/api/admin/photos/" + pid, { method: "DELETE" });
      const news = A.form.photos.filter((p) => !p.id);
      let n = 0;
      for (const p of news) {
        setMsg(`상세 사진 올리는 중… ${++n}/${news.length}`);
        p.id = (await api(`/api/admin/items/${id}/photos`, { method: "POST", body: JSON.stringify({ dataUrl: p.dataUrl }) })).id;
      }
      await api(`/api/admin/items/${id}/photos/order`, { method: "PUT", body: JSON.stringify({ ids: A.form.photos.map((p) => p.id) }) });
    }
    toast(editing ? "저장되었습니다" : "등록되었습니다");
    await load(); resetForm(); refresh();
  } catch (er) { setMsg(er.message, true); }
  $("#f_save").disabled = false;
}
function refreshItems() {
  const tb = $("#itbody"); if (!tb) return;
  const its = A.ov.items;
  if (!its.length) { tb.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:20px">등록된 물품이 없습니다. 위에서 물품을 등록해 주세요.</td></tr>`; return; }
  tb.innerHTML = its.map((it) => `<tr>
    <td class="num"><b>${esc(it.no)}</b></td>
    <td>${imgUrl(it) ? `<img src="${imgUrl(it)}" alt="" style="width:48px;height:36px;object-fit:cover;border-radius:5px;display:block">` : "-"}</td>
    <td>${esc(it.name)}</td>
    <td class="num">${it.wish.count ? `<button class="btn ghost sm" data-w="${esc(it.id)}" title="중앙값 ${won(it.wish.median)} · 최저 ${won(it.wish.min)} · 최고 ${won(it.wish.max)}">${it.wish.count}명 · 평균 ${won(it.wish.avg)}</button>` : `<span style="color:var(--muted)">-</span>`}</td>
    <td class="num">${it.start ? won(it.start) : `<span style="color:var(--red)">미정</span>`}</td><td class="num">${it.top ? won(it.top.amount) : "-"}</td>
    <td class="num">${it.bidCount}</td><td class="num">${fmtDT(it.endAt)}</td><td>${statusText(it)}</td>
    <td style="white-space:nowrap"><button class="btn ghost sm" data-b="${esc(it.id)}">입찰내역</button> <button class="btn ghost sm" data-e="${esc(it.id)}">수정</button> <button class="btn ghost sm" data-d="${esc(it.id)}" style="color:var(--red)">삭제</button></td></tr>`).join("");
  $$("[data-e]", tb).forEach((b) => (b.onclick = () => editItem(b.dataset.e)));
  $$("[data-b]", tb).forEach((b) => (b.onclick = () => showBids(b.dataset.b)));
  $$("[data-w]", tb).forEach((b) => (b.onclick = () => showWishes(b.dataset.w)));
  $$("[data-d]", tb).forEach((b) => (b.onclick = async () => {
    const it = its.find((x) => x.id === b.dataset.d);
    if (!(await modal({ title: "물품 삭제", body: `No.${it.no} ${it.name}을(를) 삭제합니다.${it.bidCount ? `\n입찰 ${it.bidCount}건도 함께 삭제됩니다.` : ""}`, ok: "삭제", danger: true }))) return;
    try { await api("/api/admin/items/" + it.id, { method: "DELETE" }); toast("삭제되었습니다"); if (A.form.id === it.id) resetForm(); } catch (e) { toast(e.message); }
  }));
}
async function showWishes(id) {
  const it = A.ov.items.find((x) => x.id === id), w = it.wish;
  const { wishes } = await api(`/api/admin/items/${id}/wishes`);
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<div class="mbox" style="max-width:560px"><h3>No.${esc(it.no)} ${esc(it.name)} · 희망가 ${w.count}명</h3>
    <div class="stats" style="margin:8px 0 12px"><div class="stat"><b>${won(w.avg)}</b><span>평균</span></div><div class="stat"><b>${won(w.median)}</b><span>중앙값</span></div><div class="stat"><b>${won(w.min)}</b><span>최저</span></div><div class="stat"><b>${won(w.max)}</b><span>최고</span></div></div>
    <div class="tscroll" style="max-height:45vh;overflow:auto;margin-bottom:12px"><table class="t"><thead><tr><th>사번</th><th>희망가</th><th>남긴 시각</th></tr></thead><tbody>
    ${wishes.map((x) => `<tr><td class="num">${esc(x.emp)}</td><td class="num"><b>${won(x.amount)}</b></td><td class="num">${fmtDTs(x.at)}</td></tr>`).join("")}</tbody></table></div>
    <p style="font-size:12px;color:var(--muted);margin:0 0 12px">시작가는 ‘수정’에서 직접 넣어 주세요.<br>터무니없는 금액이 섞여 있으면 평균보다 <b>중앙값</b>이 더 믿을 만해요.</p>
    <div class="row"><button class="btn ghost" data-close>닫기</button><button class="btn" data-edit>이 물품 시작가 수정</button></div></div>`;
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.dataset.close != null) m.remove();
    if (e.target.dataset.edit != null) { m.remove(); editItem(id); setTimeout(() => $("#f_start").focus(), 300); }
  });
  document.body.appendChild(m);
}
async function showBids(id) {
  const it = A.ov.items.find((x) => x.id === id);
  const { bids } = await api(`/api/admin/items/${id}/bids`);
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<div class="mbox" style="max-width:640px"><h3>No.${esc(it.no)} ${esc(it.name)} · 입찰 ${bids.length}건</h3>
    <div class="tscroll" style="max-height:60vh;overflow:auto;margin:10px 0 16px"><table class="t"><thead><tr><th>순위</th><th>사번</th><th>연락처</th><th>금액</th><th>시각</th><th></th></tr></thead><tbody>
    ${bids.map((b, i) => `<tr><td class="num">${i + 1}</td><td class="num">${esc(b.emp)}</td><td class="num">${esc(b.phone || "-")}</td><td class="num"><b>${won(b.amount)}</b></td><td class="num">${fmtDTs(b.at)}</td><td>${it.settledAt ? "" : `<button class="btn ghost sm" data-x="${b.id}" style="color:var(--red)">취소</button>`}</td></tr>`).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">입찰이 없습니다.</td></tr>`}
    </tbody></table></div><p style="font-size:12px;color:var(--muted);margin:0 0 12px">잘못 입력된 입찰(예: 0을 하나 더 누른 경우)은 경매가 끝나기 전에만 취소할 수 있습니다.</p><div class="row"><button class="btn" data-close>닫기</button></div></div>`;
  m.addEventListener("click", async (e) => {
    if (e.target === m || e.target.dataset.close != null) m.remove();
    const x = e.target.dataset.x;
    if (x) {
      if (!(await modal({ title: "입찰 취소", body: "이 입찰을 취소할까요? 되돌릴 수 없습니다.", ok: "입찰 취소", danger: true }))) return;
      try { await api("/api/admin/bids/" + x, { method: "DELETE" }); m.remove(); toast("취소되었습니다"); showBids(id); } catch (er) { toast(er.message); }
    }
  });
  document.body.appendChild(m);
}

/* ---------------- results ---------------- */
const RS = { won: ["낙찰완료", "won"], leading: ["진행중 · 최고가", "live"], outbid: ["진행중 · 추월됨", "live"], lost: ["미낙찰", "lost"], none: ["입찰 없음", "none"] };
const SMSL = { preview: ["미리보기", "preview"], sent: ["발송완료", "sent"], failed: ["실패", "failed"], none: ["기록 없음", "failed"] };
function buildRoster() {
  A.rf = A.rf || "all"; A.rsort = A.rsort || { k: null, dir: 1 };
  $("#abody").innerHTML = `
  <div class="row" style="justify-content:space-between;margin-bottom:10px">
    <div class="row" id="rfilters"></div>
    <div class="row"><button class="btn ghost sm" id="cpP">낙찰자 번호 복사</button><button class="btn sm" id="dlAll">전체 명단 엑셀(CSV) 받기</button></div>
  </div>
  <div class="tscroll"><table class="t" id="rtable"><thead><tr>
    <th data-k="i">번호</th><th data-k="emp">사번</th><th data-k="phone">휴대폰 번호</th><th data-k="item">물품명</th><th data-k="state">상태</th><th data-k="amount">낙찰가/현재가</th><th data-k="sms">문자</th>
  </tr></thead><tbody id="rbody"><tr><td colspan="7" style="color:var(--muted)">불러오는 중…</td></tr></tbody></table></div>
  <p style="font-size:12px;color:var(--muted)">열 제목을 누르면 정렬돼요. 한 사람이 여러 물품에 입찰했다면 물품마다 한 줄씩 보여요.</p>`;
  $$("#rtable th[data-k]").forEach((th) => (th.onclick = () => { const k = th.dataset.k; A.rsort = { k, dir: A.rsort.k === k ? -A.rsort.dir : 1 }; drawRoster(); }));
  $("#dlAll").onclick = async () => {
    try {
      const blob = await api("/api/admin/export.csv?type=roster");
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `경매_전체명단_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(e.message); }
  };
  $("#cpP").onclick = async () => {
    const t = [...new Set((A.roster || []).filter((r) => r.state === "won" && r.phone).map((r) => r.phone))].join(", ");
    if (!t) return toast("낙찰자 번호가 없습니다");
    try { await navigator.clipboard.writeText(t); toast("복사되었습니다"); } catch (e) { modal({ title: "낙찰자 번호", body: t, cancel: null }); }
  };
  loadRoster();
}
async function loadRoster() {
  if (!$("#rbody")) return;
  try { A.roster = (await api("/api/admin/roster")).rows; } catch (e) { return; }
  drawRoster();
}
function drawRoster() {
  const all = A.roster || [];
  const F = [["all", "전체"], ["won", "낙찰완료"], ["live", "진행중"], ["lost", "미낙찰"], ["none", "입찰 없음"]];
  const cnt = (k) => (k === "all" ? all.length : all.filter((r) => RS[r.state][1] === k).length);
  $("#rfilters").innerHTML = F.map(([k, l]) => `<button class="chip ${A.rf === k ? "on" : ""}" data-rf="${k}">${l} <span style="opacity:.7">${cnt(k)}</span></button>`).join("");
  $$("#rfilters [data-rf]").forEach((b) => (b.onclick = () => { A.rf = b.dataset.rf; drawRoster(); }));
  let rows = all.map((r, i) => ({ ...r, i: i + 1 })).filter((r) => A.rf === "all" || RS[r.state][1] === A.rf);
  const { k, dir } = A.rsort;
  if (k) {
    const val = (r) => k === "item" ? (r.item ? r.item.name : "") : k === "state" ? Object.keys(RS).indexOf(r.state) : k === "sms" ? (r.sms || "") : r[k] ?? "";
    rows.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko")) * dir; });
  }
  $$("#rtable th[data-k]").forEach((th) => { th.dataset.dir = th.dataset.k === k ? (dir > 0 ? "▲" : "▼") : ""; });
  $("#rbody").innerHTML = rows.map((r) => `<tr>
    <td class="num">${r.i}</td><td class="num">${esc(r.emp)}</td><td class="num">${esc(r.phone || "-")}</td>
    <td>${r.item ? esc(r.item.name) : `<span style="color:var(--muted)">-</span>`}</td>
    <td><span class="st st-${RS[r.state][1]}">${RS[r.state][0]}</span></td>
    <td class="num">${r.amount != null ? won(r.amount) : "-"}</td>
    <td>${r.state === "won" ? `<span class="pill ${SMSL[r.sms][1]}">${SMSL[r.sms][0]}</span> <button class="btn ghost sm" data-n="${esc(r.item.id)}">${A.ov.smsMode === "live" ? "다시 보내기" : "기록 남기기"}</button>` : "-"}</td></tr>`).join("")
    || `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:18px">해당하는 사람이 없어요.</td></tr>`;
  $$("#rbody [data-n]").forEach((b) => (b.onclick = async () => {
    const it = A.ov.items.find((x) => x.id === b.dataset.n), live = A.ov.smsMode === "live";
    if (!(await modal({ title: live ? "문자 다시 보내기" : "문자 기록 남기기", body: `${it.name}\n낙찰자 ${it.winner.emp} (${it.winner.phone})${live ? "\n\n실제로 문자가 발송됩니다." : "\n\n테스트 모드라 실제로 보내지 않고 기록만 남깁니다."}`, ok: live ? "보내기" : "기록 남기기" }))) return;
    try { await api(`/api/admin/items/${it.id}/notify`, { method: "POST" }); await load(); loadRoster(); toast(live ? "발송 요청했습니다" : "기록을 남겼습니다"); } catch (e) { toast(e.message); }
  }));
}

/* ---------------- sms ---------------- */
function buildSms() {
  const ov = A.ov;
  A.tpl = ov.template;
  const live = ov.smsMode === "live";
  if (!A.pvItem || !ov.items.some((i) => i.id === A.pvItem)) A.pvItem = (ov.items.find((i) => i.status === "sold") || ov.items[0] || {}).id || "";
  $("#abody").innerHTML = `
  <div class="note" style="margin-top:0">
    <b>문자는 이렇게 나가요</b><br>
    · <b>받는 사람</b>: 물품마다 그 물품의 <b>낙찰자</b>에게 자동으로 보냅니다.<br>&nbsp;&nbsp;따로 고를 필요가 없어요.<br>
    · <b>보내는 때</b>: 각 물품의 경매가 끝나는 순간 자동으로 보냅니다.${live ? "" : " (지금은 테스트 모드라 기록만 남아요)"}<br>
    · <b>문구</b>: 아래 문구 <b>하나</b>를 모든 낙찰자가 같이 씁니다.<br>&nbsp;&nbsp;<code>{물품명}</code> <code>{낙찰가}</code> 같은 칸은 보낼 때 물품마다 자동으로 채워져요.<br>
    · <b>다시 보내기</b>: 오른쪽 미리보기에서 물품을 고르고 버튼을 누르거나, ‘낙찰 결과’ 탭에서 보낼 수 있어요.
  </div>
  <div class="detail" style="grid-template-columns:1.15fr 1fr;padding-bottom:0">
    <div class="panel"><h3 style="margin:0 0 4px">낙찰 안내 문구 (모든 낙찰자 공통)</h3>
      <p style="font-size:13px;color:var(--muted);margin:0 0 8px">버튼을 누르면 커서 위치에 자동입력 칸이 들어갑니다.<br>실제 문자에서는 물품마다 값이 바뀌어요.</p>
      <div class="row" id="vars">${[["{물품명}", "물품 이름"], ["{낙찰가}", "낙찰 금액"], ["{번호}", "물품 번호"], ["{사번}", "낙찰자 사번"], ["{행사명}", "행사 이름"]].map(([v, l]) => `<button class="chip" data-v="${v}" title="${l}">${v} <span style="color:var(--muted);font-size:11px">${l}</span></button>`).join("")}</div>
      <textarea class="t" id="tpl" rows="6" style="margin-top:10px">${esc(ov.template)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="tplSave">문구 저장</button><button class="btn ghost sm" id="tplReset">기본 문구로</button><span class="msg" id="tplMsg"></span></div>
    </div>
    <div class="panel"><h3 style="margin:0 0 8px">미리보기</h3>
      <label class="f" for="pvSel" style="margin-top:0">어떤 물품으로 볼까요?</label>
      <select class="t" id="pvSel">${ov.items.length ? ov.items.map((i) => `<option value="${esc(i.id)}" ${i.id === A.pvItem ? "selected" : ""}>No.${esc(i.no)} ${esc(i.name)} · ${statusText(i)}</option>`).join("") : `<option value="">(등록된 물품 없음 — 예시 값으로 표시)</option>`}</select>
      <div id="pvTo" style="font-size:13px;margin:10px 0 0"></div>
      <div class="phone-sms"><div class="from">${esc(ov.eventName)} · 발신번호 (솔라피에 등록한 번호)</div><div class="bubble" id="pv"></div></div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px" id="pvMeta"></div>
      <div class="row" style="margin-top:12px"><button class="btn sm hidden" id="pvSend"></button></div>
    </div>
  </div>
  <div class="panel" style="margin-top:16px"><h3 style="margin:0 0 10px">발송 기록 <span style="font-weight:400;color:var(--muted);font-size:13px">${live ? "실제 발송 모드" : "테스트 모드 — 실제로 발송되지 않음"}</span></h3>
    <div class="tscroll"><table class="t"><thead><tr><th>시각</th><th>물품</th><th>받는 번호</th><th>구분</th><th>상태</th><th>내용</th></tr></thead><tbody id="smsBody"></tbody></table></div></div>`;
  const ta = $("#tpl"), sel = $("#pvSel");
  const dirty = () => { const d = ta.value.trim() !== (A.ov.template || "").trim(); $("#tplMsg").className = "msg " + (d ? "err" : ""); $("#tplMsg").textContent = d ? "저장 안 됨 — ‘문구 저장’을 눌러야 실제 문자에 반영돼요" : ""; };
  let pvT;
  const preview = () => { clearTimeout(pvT); pvT = setTimeout(async () => {
    try {
      const r = await api("/api/admin/sms-preview", { method: "POST", body: JSON.stringify({ template: ta.value, itemId: sel.value || null }) });
      $("#pv").textContent = r.text;
      $("#pvMeta").textContent = `${r.bytes}byte · ${r.type}${r.type === "LMS" ? " (90byte 초과 → 장문 요금)" : " (단문)"}${r.to ? "" : " · 예시 값으로 채운 모습"}`;
      const t = r.to, btn = $("#pvSend");
      $("#pvTo").innerHTML = !t ? "" :
        t.state === "sold" ? `<b>받는 사람</b>: 낙찰자 <b>${esc(t.emp)}</b> · ${esc(t.phone || "(번호 삭제됨)")}` :
        t.state === "leading" ? `<b>받는 사람</b>: 아직 진행중 — 지금 최고가 입찰자 <b>${esc(t.emp)}</b> · ${esc(t.phone)}<br><span style="color:var(--muted)">경매가 끝날 때 최고가인 사람에게 자동으로 보내요.</span>` :
        t.state === "nobid" ? `<span style="color:var(--muted)">아직 입찰자가 없습니다.<br>경매가 끝날 때 낙찰자에게 자동으로 보내요.<br>(금액은 시작가로 표시)</span>` :
        `<span style="color:var(--muted)">유찰 — 보낼 사람이 없습니다.</span>`;
      const it = A.ov.items.find((i) => i.id === sel.value);
      btn.classList.toggle("hidden", !(t && t.state === "sold"));
      btn.textContent = live ? "이 낙찰자에게 지금 보내기" : "이 낙찰자에게 보내기 (테스트: 기록만)";
      btn.onclick = async () => {
        if (ta.value.trim() !== (A.ov.template || "").trim()) return toast("먼저 ‘문구 저장’을 눌러 주세요");
        if (!(await modal({ title: live ? "문자 보내기" : "테스트 발송 기록", body: `No.${it.no} ${it.name}\n받는 사람: ${t.emp} (${t.phone})${live ? "\n\n실제로 문자가 발송됩니다." : "\n\n테스트 모드라 실제로 보내지 않고 발송 기록에만 남깁니다."}`, ok: live ? "보내기" : "기록 남기기" }))) return;
        try { await api(`/api/admin/items/${it.id}/notify`, { method: "POST" }); await load(); refreshSmsLog(); toast(live ? "발송 요청했습니다" : "발송 기록에 추가했습니다"); } catch (e) { toast(e.message); }
      };
    } catch (e) {}
  }, 200); };
  ta.addEventListener("input", () => { preview(); dirty(); });
  sel.addEventListener("change", () => { A.pvItem = sel.value; preview(); });
  preview();
  $$("#vars [data-v]").forEach((b) => (b.onclick = () => { const s = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, s) + b.dataset.v + ta.value.slice(ta.selectionEnd ?? s); ta.focus(); ta.selectionStart = ta.selectionEnd = s + b.dataset.v.length; preview(); dirty(); }));
  $("#tplSave").onclick = async () => { try { const r = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ template: ta.value }) }); A.ov.template = r.template; ta.value = r.template; $("#tplMsg").className = "msg ok"; $("#tplMsg").textContent = "저장되었습니다. 앞으로 나가는 문자에 이 문구가 쓰입니다."; } catch (e) { $("#tplMsg").className = "msg err"; $("#tplMsg").textContent = e.message; } };
  $("#tplReset").onclick = () => { ta.value = ov.defaultTemplate; preview(); dirty(); };
}
function refreshSmsLog() {
  const tb = $("#smsBody"); if (!tb) return;
  const its = Object.fromEntries(A.ov.items.map((i) => [i.id, i]));
  tb.innerHTML = A.ov.sms.map((s) => `<tr><td class="num">${fmtDTs(s.at)}</td><td>${its[s.item_id] ? "No." + esc(its[s.item_id].no) + " " + esc(its[s.item_id].name) : "-"}</td>
    <td class="num">${esc(s.to_phone || "-")}</td><td>${s.kind === "auto" ? "자동(종료 시)" : "수동"} · ${s.bytes > 90 ? "LMS" : "SMS"}</td>
    <td><span class="pill ${s.status}" title="${esc(s.detail)}">${s.status === "preview" ? "미리보기" : s.status === "sent" ? "발송완료" : "실패"}</span></td>
    <td style="max-width:360px;font-size:12.5px;white-space:pre-wrap">${esc(s.text)}</td></tr>`).join("")
    || `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:18px">아직 기록이 없습니다. 경매가 끝나면 낙찰자별로 자동 기록됩니다.</td></tr>`;
}

/* ---------------- 작업 기록 ---------------- */
async function buildLog() {
  const box = $("#abody"); if (!box) return;
  if (!box.querySelector("#logBody")) box.innerHTML = `<div class="note" style="margin-top:0">관리자가 한 작업이 모두 자동으로 남아요.<br>입찰 취소처럼 민감한 작업은 <b>누가, 언제, 어떤 입찰을</b> 취소했는지 확인할 수 있어요.<br>기록은 지울 수 없어요.</div>
    <div class="row" style="margin:6px 0 10px"><button class="chip on" data-lf="">전체</button><button class="chip" data-lf="입찰 취소">입찰 취소만</button></div>
    <div class="tscroll"><table class="t"><thead><tr><th>시각</th><th>관리자 사번</th><th>작업</th><th>물품</th><th>내용</th></tr></thead><tbody id="logBody"><tr><td colspan="5" style="color:var(--muted)">불러오는 중…</td></tr></tbody></table></div>`;
  $$("[data-lf]", box).forEach((b) => (b.onclick = () => { A.logFilter = b.dataset.lf; $$("[data-lf]", box).forEach((x) => x.classList.toggle("on", x === b)); drawLog(); }));
  try { A.log = (await api("/api/admin/log")).log; } catch (e) { return; }
  drawLog();
}
function drawLog() {
  const tb = $("#logBody"); if (!tb) return;
  const rows = (A.log || []).filter((r) => !A.logFilter || r.action === A.logFilter);
  tb.innerHTML = rows.map((r) => `<tr><td class="num">${fmtDTs(r.at)}</td><td class="num">${esc(r.emp)}</td><td>${r.action === "입찰 취소" ? `<b style="color:var(--red)">${esc(r.action)}</b>` : esc(r.action)}</td><td>${r.item_no ? `No.${esc(r.item_no)} ${esc(r.item_name)}` : "-"}</td><td style="font-size:12.5px">${esc(r.detail || "")}</td></tr>`).join("")
    || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:18px">기록이 없어요.</td></tr>`;
}

/* ---------------- data ---------------- */
function buildEtc() {
  const hasSample = A.ov.items.some((i) => i.sample);
  $("#abody").innerHTML = `
  <div class="panel"><h3 style="margin:0 0 6px">샘플 물품 (미리보기용)</h3>
    <p style="font-size:14px;color:#3a433d;margin:0 0 12px">화면 확인용 <b>[샘플]</b> 물품을 원하는 개수와 상태로 넣어요.<br>샘플 물품은 실제 발송 모드에서도 <b>문자가 나가지 않습니다</b>.</p>
    <div class="row">
      <select class="t" id="smpN" style="width:auto">${[1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20].map((n) => `<option value="${n}" ${n === 6 ? "selected" : ""}>${n}개</option>`).join("")}</select>
      <select class="t" id="smpS" style="width:auto">
        <option value="mix">상태: 골고루 섞어서</option><option value="ready">상태: 준비중 (입찰 없음)</option><option value="live">상태: 진행중 (입찰 있음)</option><option value="done">상태: 완료 (이미 낙찰)</option>
      </select>
      <button class="btn sm" id="seed">샘플 물품 넣기</button><button class="btn ghost sm" id="unseed" ${hasSample ? "" : "disabled"}>샘플 물품 삭제</button>
    </div>
    <div class="msg" id="seedMsg"></div></div>
  <div class="panel" style="margin-top:16px"><h3 style="margin:0 0 6px">세부 자료 받기</h3>
    <p style="font-size:14px;color:#3a433d;margin:0 0 12px">전체 명단은 ‘데이터 관리’ 탭에서 받아요.<br>아래는 필요할 때만 쓰는 세부 자료예요.</p>
    <div class="row"><button class="btn ghost sm" data-dl="bids">전체 입찰 기록</button><button class="btn ghost sm" data-dl="wishes">희망가 기록</button><button class="btn ghost sm" data-dl="winners">물품별 낙찰 결과</button></div></div>
  <div class="panel" style="margin-top:16px"><h3 style="margin:0 0 6px">개인정보 삭제</h3>
    <p style="font-size:14px;color:#3a433d;margin:0 0 12px">낙찰 안내가 끝나면 수집한 휴대폰 번호를 모두 지워 주세요.<br>사번과 입찰 기록, 낙찰 결과는 남고 <b>번호만</b> 지워집니다.<br>참여자는 다시 로그인해야 합니다.</p>
    <button class="btn red sm" id="purge">휴대폰 번호 전체 삭제</button></div>
  <div class="panel" style="margin-top:16px"><h3 style="margin:0 0 6px">전체 초기화</h3>
    <p style="font-size:14px;color:#3a433d;margin:0 0 12px">물품, 사진, 입찰, 문자 기록을 모두 지웁니다.<br>테스트를 마치고 실제 행사를 시작하기 전에 사용하세요.</p>
    <button class="btn red sm" id="reset">전체 초기화</button></div>`;
  const NAMES = { bids: "입찰기록", wishes: "희망가", winners: "물품별낙찰결과" };
  $$("[data-dl]").forEach((b) => (b.onclick = async () => {
    try { const blob = await api("/api/admin/export.csv?type=" + b.dataset.dl); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `경매_${NAMES[b.dataset.dl]}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } catch (e) { toast(e.message); }
  }));
  $("#seed").onclick = async () => {
    const m = $("#seedMsg"); $("#seed").disabled = true;
    try {
      m.className = "msg"; m.textContent = "샘플 물품 만드는 중…";
      const r = await api("/api/admin/samples", { method: "POST", body: JSON.stringify({ count: Number($("#smpN").value), status: $("#smpS").value }) });
      const COLORS = [["#1f4d3a", "#2d6b52"], ["#8c5a32", "#b07a4b"], ["#b8322a", "#d4584f"], ["#3c508c", "#5a70b0"], ["#28282f", "#4a4a55"], ["#9678aa", "#b49cc6"], ["#46705a", "#6a947c"], ["#781e32", "#9e3a50"]];
      let n = 0;
      for (let i = 0; i < r.items.length; i++) {
        const it = r.items[i], [c1, c2] = COLORS[(it.no + i) % COLORS.length], title = it.name.replace("[샘플] ", "");
        m.textContent = `사진 넣는 중… ${++n}/${r.items.length}`;
        await api(`/api/admin/items/${it.id}/image`, { method: "PUT", body: JSON.stringify({ dataUrl: sampleImg(900, 675, c1, c2, title, "대표 사진") }) });
        for (const [k, sub] of [["제품 소개", "이런 제품이에요"], ["구성품", "함께 드리는 것"], ["상태", "실물 사진 자리"]].entries())
          await api(`/api/admin/items/${it.id}/photos`, { method: "POST", body: JSON.stringify({ dataUrl: sampleImg(1000, 1300, k % 2 ? c2 : c1, k % 2 ? c1 : c2, `상세 사진 ${k + 1} · ${sub[0]}`, sub[1]) }) });
      }
      m.className = "msg ok"; m.textContent = `샘플 물품 ${r.items.length}개를 넣었습니다.`;
      await load(); refresh(); $("#unseed").disabled = false;
    } catch (e) { m.className = "msg err"; m.textContent = e.message; }
    $("#seed").disabled = false;
  };
  $("#unseed").onclick = async () => {
    if (!(await modal({ title: "샘플 물품 삭제", body: "[샘플] 물품과 그 입찰·사진·문자 기록만 지웁니다.\n직접 등록한 물품은 그대로 남아요.", ok: "삭제", danger: true }))) return;
    try { const r = await api("/api/admin/samples", { method: "DELETE" }); toast(`샘플 ${r.deleted}개를 삭제했습니다`); await load(); refresh(); $("#unseed").disabled = true; } catch (e) { toast(e.message); }
  };
  $("#purge").onclick = async () => {
    if (!(await modal({ title: "휴대폰 번호 전체 삭제", body: "모든 참여자의 휴대폰 번호를 삭제합니다.\n되돌릴 수 없습니다.\n먼저 ‘낙찰 결과’에서 낙찰 결과·참여자 명단 CSV를 받아 두세요.", ok: "삭제", danger: true }))) return;
    try { await api("/api/admin/purge-personal", { method: "POST" }); toast("삭제되었습니다"); await load(); refresh(); } catch (e) { toast(e.message); }
  };
  $("#reset").onclick = async () => {
    const v = await modal({ title: "전체 초기화", body: "모든 데이터를 삭제합니다.\n계속하려면 아래에 ‘전체삭제’를 입력하세요.", ok: "초기화", danger: true, input: "전체삭제" });
    if (v == null) return;
    if (v !== "전체삭제") return toast("확인 문구가 일치하지 않습니다");
    try { await api("/api/admin/reset-all", { method: "POST", body: JSON.stringify({ confirm: v }) }); toast("초기화되었습니다"); await load(); refresh(); } catch (e) { toast(e.message); }
  };
}

/* ---------------- image ---------------- */
function sampleImg(w, h, c1, c2, title, sub) {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,.12)"; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(w * (0.1 + i * 0.18), h * 0.78, w * 0.16, 0, 7); g.fill(); }
  g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 4; g.strokeRect(36, 36, w - 72, h - 72);
  g.fillStyle = "#fff"; g.font = `900 ${Math.round(w / 15)}px "Noto Sans KR", sans-serif`; g.textAlign = "center"; g.fillText(title, w / 2, h * 0.46);
  g.font = `500 ${Math.round(w / 30)}px "Noto Sans KR", sans-serif`; g.fillText(sub, w / 2, h * 0.46 + w / 14);
  g.font = `700 ${Math.round(w / 26)}px "Noto Sans KR", sans-serif`; g.fillStyle = "rgba(255,255,255,.7)"; g.textAlign = "right"; g.fillText("SAMPLE", w - 80, h - 80);
  return c.toDataURL("image/jpeg", 0.82);
}
// tall=true: 상세 사진용 (가로 1000px 기준, 세로로 긴 이미지 허용)
function compress(file, tall = false) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const r = tall ? Math.min(1, 1000 / img.width, 9000 / img.height) : Math.min(1, 1200 / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      let q = 0.85, d = c.toDataURL("image/jpeg", q);
      const limit = tall ? 1400000 : 600000;
      while (d.length > limit && q > 0.35) { q -= 0.1; d = c.toDataURL("image/jpeg", q); }
      URL.revokeObjectURL(url); res(d);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}

/* ---------------- boot ---------------- */
(async () => {
  if (!A.me) return renderLogin();
  try { await load(); start(); } catch (e) { /* renderLogin 이미 표시 */ }
})();
