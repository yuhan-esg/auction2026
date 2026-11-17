import { $, $$, esc, won, fmtDT, fmtDTs, fmtDTfull, toLocalInput, digits, toast, modal, moneyInput, imgUrl, connectLive } from "./common.js";

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
      const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emp, phone, agree: true }) });
      const d = await r.json();
      if (!r.ok) { $("#amsg").textContent = d.error || "로그인에 실패했습니다."; return; }
      if (!d.isAdmin) { $("#amsg").textContent = "관리자로 지정된 사번·번호가 아닙니다."; return; }
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
    onStatus: (ok) => { const el = $("#live"); el.classList.toggle("off", !ok); el.lastElementChild.textContent = ok ? "실시간" : "재연결 중"; },
  });
  setInterval(() => $$(".cd[data-end]").forEach((el) => { const l = Number(el.dataset.end) - Date.now(); el.textContent = l > 0 ? "진행중" : "종료"; }), 1000);
}
async function load() { A.ov = await api("/api/admin/overview"); }

/* ---------------- shell ---------------- */
const TABS = [["items", "물품 관리"], ["results", "낙찰 결과"], ["sms", "문자 발송"], ["data", "데이터 관리"]];
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
  if (A.tab === "data") buildData();
  refresh();
}
function refresh() {
  if (!A.ov || !$("#astats")) return;
  const ov = A.ov, its = ov.items;
  const sold = its.filter((i) => i.status === "sold");
  $("#astats").innerHTML = `<div class="stat"><b>${its.length}</b><span>물품</span></div><div class="stat"><b>${its.filter((i) => i.status === "live").length}</b><span>진행중</span></div><div class="stat"><b>${ov.stats.participants}</b><span>입장한 임직원</span></div><div class="stat"><b>${ov.stats.bids}</b><span>총 입찰</span></div><div class="stat"><b>${its.reduce((a, i) => a + (i.top ? i.top.amount : 0), 0).toLocaleString("ko-KR")}</b><span>현재 모금액(원)</span></div><div class="stat hl"><b>${sold.reduce((a, i) => a + i.top.amount, 0).toLocaleString("ko-KR")}</b><span>낙찰 확정액(원)</span></div>`;
  if (A.tab === "items") refreshItems();
  if (A.tab === "results") renderResults();
  if (A.tab === "sms") refreshSmsLog();
}
const statusText = (i) => (i.status === "sold" ? "낙찰완료" : i.status === "unsold" ? "유찰" : "진행중");

/* ---------------- items ---------------- */
function defaultEnd() { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(18, 0, 0, 0); return d.getTime(); }
function nextNo() { return (A.ov.items.reduce((m, x) => Math.max(m, x.no || 0), 0) || 0) + 1; }
function buildItems() {
  $("#abody").innerHTML = `
  <div class="panel" id="formPanel"><h3 style="margin:0 0 6px" id="ftitle">물품 등록</h3>
    <form id="ifm" class="formgrid" novalidate>
      <div><label class="f" for="f_no">번호</label><input class="t" id="f_no" inputmode="numeric"></div>
      <div><label class="f" for="f_name">물품명</label><input class="t" id="f_name" maxlength="100"></div>
      <div><label class="f" for="f_start">시작가 (원)</label><input class="t" id="f_start" inputmode="numeric"></div>
      <div><label class="f" for="f_step">입찰 단위 (원)</label><input class="t" id="f_step" inputmode="numeric"></div>
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
    <div class="tscroll"><table class="t"><thead><tr><th>No.</th><th>사진</th><th>물품명</th><th>시작가</th><th>현재가</th><th>입찰</th><th>종료</th><th>상태</th><th></th></tr></thead><tbody id="itbody"></tbody></table></div>
  </div>`;
  ["f_start", "f_step"].forEach((i) => moneyInput($("#" + i)));
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
function resetForm() {
  A.form = { id: null, img: null, imgChanged: false, photos: [], removed: [], photosChanged: false };
  renderPlist();
  $("#ifm").reset(); $("#ftitle").textContent = "물품 등록"; $("#f_save").textContent = "등록하기"; $("#f_cancel").classList.add("hidden"); showPrev(null);
  $("#f_no").value = nextNo(); $("#f_start").value = "10,000"; $("#f_step").value = "1,000"; $("#f_end").value = toLocalInput(defaultEnd()); setMsg("");
}
async function editItem(id) {
  const it = A.ov.items.find((x) => x.id === id); if (!it) return;
  A.form = { id, img: imgUrl(it) || null, imgChanged: false, photos: [], removed: [], photosChanged: false };
  renderPlist();
  fetch("/api/items/" + encodeURIComponent(id), { cache: "no-store" }).then((r) => r.json()).then((d) => {
    if (A.form.id !== id) return;
    A.form.photos = (d.photos || []).map((pid) => ({ id: pid, src: "/api/photo/" + pid })); renderPlist();
  }).catch(() => {});
  $("#f_no").value = it.no; $("#f_name").value = it.name; $("#f_start").value = Number(it.start).toLocaleString("ko-KR"); $("#f_step").value = Number(it.step).toLocaleString("ko-KR");
  $("#f_end").value = toLocalInput(it.endAt); $("#f_donor").value = it.donor || ""; $("#f_desc").value = it.description || ""; showPrev(A.form.img);
  $("#ftitle").textContent = `No.${it.no} 수정`; $("#f_save").textContent = "저장하기"; $("#f_cancel").classList.remove("hidden"); setMsg("");
  $("#formPanel").scrollIntoView({ behavior: "smooth" });
}
async function saveItem(e) {
  e.preventDefault();
  const n = (id) => Number(digits($("#" + id).value));
  const data = { no: n("f_no"), name: $("#f_name").value.trim(), start: n("f_start"), step: n("f_step"), endAt: new Date($("#f_end").value).getTime(), donor: $("#f_donor").value.trim(), description: $("#f_desc").value.trim() };
  if (!data.no) return setMsg("번호를 입력해 주세요.", true);
  if (!data.name) return setMsg("물품명을 입력해 주세요.", true);
  if (!data.step) return setMsg("입찰 단위를 입력해 주세요.", true);
  if (!data.endAt) return setMsg("종료 시각을 입력해 주세요.", true);
  const editing = A.form.id;
  if (editing) {
    const old = A.ov.items.find((x) => x.id === editing);
    if (old && old.bidCount && (data.start !== old.start || data.step !== old.step) &&
      !(await modal({ title: "입찰이 있는 물품입니다", body: `이미 입찰 ${old.bidCount}건이 있습니다.\n시작가·입찰 단위를 바꾸면 다음 최소 입찰가가 달라집니다.`, ok: "그래도 저장" }))) return;
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
  if (!its.length) { tb.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:20px">등록된 물품이 없습니다. 위에서 물품을 등록해 주세요.</td></tr>`; return; }
  tb.innerHTML = its.map((it) => `<tr>
    <td class="num"><b>${esc(it.no)}</b></td>
    <td>${imgUrl(it) ? `<img src="${imgUrl(it)}" alt="" style="width:48px;height:36px;object-fit:cover;border-radius:5px;display:block">` : "-"}</td>
    <td>${esc(it.name)}</td><td class="num">${won(it.start)}</td><td class="num">${it.top ? won(it.top.amount) : "-"}</td>
    <td class="num">${it.bidCount}</td><td class="num">${fmtDT(it.endAt)}</td><td>${statusText(it)}</td>
    <td style="white-space:nowrap"><button class="btn ghost sm" data-b="${esc(it.id)}">입찰내역</button> <button class="btn ghost sm" data-e="${esc(it.id)}">수정</button> <button class="btn ghost sm" data-d="${esc(it.id)}" style="color:var(--red)">삭제</button></td></tr>`).join("");
  $$("[data-e]", tb).forEach((b) => (b.onclick = () => editItem(b.dataset.e)));
  $$("[data-b]", tb).forEach((b) => (b.onclick = () => showBids(b.dataset.b)));
  $$("[data-d]", tb).forEach((b) => (b.onclick = async () => {
    const it = its.find((x) => x.id === b.dataset.d);
    if (!(await modal({ title: "물품 삭제", body: `No.${it.no} ${it.name}을(를) 삭제합니다.${it.bidCount ? `\n입찰 ${it.bidCount}건도 함께 삭제됩니다.` : ""}`, ok: "삭제", danger: true }))) return;
    try { await api("/api/admin/items/" + it.id, { method: "DELETE" }); toast("삭제되었습니다"); if (A.form.id === it.id) resetForm(); } catch (e) { toast(e.message); }
  }));
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
function renderResults() {
  const its = A.ov.items;
  const lastSms = {}; for (const s of A.ov.sms) if (!lastSms[s.item_id] && s.kind !== "test") lastSms[s.item_id] = s;
  $("#abody").innerHTML = `
  <div class="row" style="margin-bottom:10px"><button class="btn sm" id="dlW">낙찰 결과 엑셀(CSV) 받기</button><button class="btn ghost sm" id="dlB">전체 입찰 내역 CSV 받기</button><button class="btn ghost sm" id="dlP">참여자 명단 CSV 받기</button><button class="btn ghost sm" id="cpP">낙찰자 번호 복사</button></div>
  <div class="tscroll"><table class="t"><thead><tr><th>No.</th><th>물품명</th><th>상태</th><th>낙찰가 / 현재가</th><th>사번</th><th>연락처</th><th>입찰</th><th>문자</th><th></th></tr></thead><tbody>
  ${its.map((it) => { const w = it.winner, l = it.leader, s = lastSms[it.id]; return `<tr>
    <td class="num"><b>${esc(it.no)}</b></td><td>${esc(it.name)}</td>
    <td>${it.status === "sold" ? `<b style="color:var(--red)">낙찰완료</b>` : it.status === "unsold" ? "유찰" : `진행중 <span style="color:var(--muted);font-size:12px">~${fmtDT(it.endAt)}</span>`}</td>
    <td class="num">${w ? `<b>${won(w.amount)}</b>` : l ? `<span style="color:var(--muted)">${won(l.amount)}</span>` : "-"}</td>
    <td class="num">${esc(w ? w.emp : l ? l.emp : "-")}</td><td class="num">${esc(w ? w.phone || "(삭제됨)" : l ? l.phone : "-")}</td>
    <td class="num">${it.bidCount}</td>
    <td>${s ? `<span class="pill ${s.status}">${s.status === "preview" ? "미리보기" : s.status === "sent" ? "발송완료" : "실패"}</span>` : it.status === "sold" ? `<span class="pill failed">기록 없음</span>` : "-"}</td>
    <td>${it.status === "sold" ? `<button class="btn ghost sm" data-n="${esc(it.id)}">${A.ov.smsMode === "live" ? "문자 다시 보내기" : "문자 미리보기 생성"}</button>` : ""}</td></tr>`; }).join("") || `<tr><td colspan="9" style="text-align:center;color:var(--muted)">물품이 없습니다.</td></tr>`}
  </tbody></table></div>
  <p style="font-size:12px;color:var(--muted)">진행중 물품은 현재 최고가 입찰자가 회색으로 표시됩니다. 경매가 끝나는 즉시 낙찰이 확정되고 문자 발송(테스트 모드에서는 미리보기 기록)이 자동으로 실행됩니다.</p>`;
  const dl = async (type) => {
    try {
      const blob = await api("/api/admin/export.csv?type=" + type);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `경매_${{ bids: "입찰내역", participants: "참여자명단" }[type] || "낙찰결과"}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(e.message); }
  };
  $("#dlW").onclick = () => dl("winners"); $("#dlB").onclick = () => dl("bids"); $("#dlP").onclick = () => dl("participants");
  $("#cpP").onclick = async () => {
    const t = its.filter((i) => i.winner && i.winner.phone).map((i) => i.winner.phone).join(", ");
    if (!t) return toast("낙찰자 번호가 없습니다");
    try { await navigator.clipboard.writeText(t); toast("복사되었습니다"); } catch (e) { modal({ title: "낙찰자 번호", body: t, cancel: null }); }
  };
  $$("[data-n]").forEach((b) => (b.onclick = async () => {
    const it = its.find((x) => x.id === b.dataset.n);
    const live = A.ov.smsMode === "live";
    if (!(await modal({ title: live ? "문자 다시 보내기" : "문자 미리보기 생성", body: `No.${it.no} ${it.name}\n낙찰자 ${it.winner.emp} (${it.winner.phone})${live ? "\n\n실제로 문자가 발송됩니다." : "\n\n테스트 모드라 실제로 보내지 않고 기록만 남깁니다."}`, ok: live ? "보내기" : "생성" }))) return;
    try { await api(`/api/admin/items/${it.id}/notify`, { method: "POST" }); await load(); refresh(); toast(live ? "발송 요청했습니다" : "미리보기가 기록되었습니다"); } catch (e) { toast(e.message); }
  }));
}

/* ---------------- sms ---------------- */
function buildSms() {
  const ov = A.ov;
  A.tpl = ov.template;
  $("#abody").innerHTML = `
  <div class="detail" style="grid-template-columns:1.2fr 1fr;padding-bottom:0">
    <div class="panel"><h3 style="margin:0 0 4px">낙찰 안내 문자 내용</h3>
      <p style="font-size:13px;color:var(--muted);margin:0 0 8px">아래 칸을 누르면 커서 위치에 넣을 수 있어요.</p>
      <div class="row" id="vars">${["{행사명}", "{번호}", "{물품명}", "{낙찰가}", "{사번}"].map((v) => `<button class="chip" data-v="${v}">${v}</button>`).join("")}</div>
      <textarea class="t" id="tpl" rows="6" style="margin-top:10px">${esc(ov.template)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="tplSave">저장</button><button class="btn ghost sm" id="tplReset">기본 문구로</button><span class="msg" id="tplMsg"></span></div>
    </div>
    <div class="panel"><h3 style="margin:0 0 4px">미리보기</h3><div style="font-size:13px;color:var(--muted)" id="pvMeta"></div>
      <div class="phone-sms"><div class="from">${esc(ov.eventName)} · 발신번호 (솔라피에 등록한 번호)</div><div class="bubble" id="pv"></div></div>
    </div>
  </div>
  <div class="panel" style="margin-top:16px"><h3 style="margin:0 0 10px">발송 기록 <span style="font-weight:400;color:var(--muted);font-size:13px">${ov.smsMode === "live" ? "실제 발송 모드" : "테스트 모드 — 실제로 발송되지 않음"}</span></h3>
    <div class="tscroll"><table class="t"><thead><tr><th>시각</th><th>물품</th><th>받는 번호</th><th>구분</th><th>상태</th><th>내용</th></tr></thead><tbody id="smsBody"></tbody></table></div></div>`;
  const ta = $("#tpl");
  let pvT;
  const preview = () => { clearTimeout(pvT); pvT = setTimeout(async () => {
    try { const r = await api("/api/admin/sms-preview", { method: "POST", body: JSON.stringify({ template: ta.value }) });
      $("#pv").textContent = r.text; $("#pvMeta").textContent = `${r.bytes}byte · ${r.type}${r.type === "LMS" ? " (90byte 초과 → 장문 요금)" : " (단문)"} · 예시 값으로 채운 모습`; } catch (e) {}
  }, 200); };
  ta.addEventListener("input", preview); preview();
  $$("#vars [data-v]").forEach((b) => (b.onclick = () => { const s = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, s) + b.dataset.v + ta.value.slice(ta.selectionEnd ?? s); ta.focus(); ta.selectionStart = ta.selectionEnd = s + b.dataset.v.length; preview(); }));
  $("#tplSave").onclick = async () => { try { const r = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ template: ta.value }) }); A.ov.template = r.template; $("#tplMsg").className = "msg ok"; $("#tplMsg").textContent = "저장되었습니다"; } catch (e) { $("#tplMsg").className = "msg err"; $("#tplMsg").textContent = e.message; } };
  $("#tplReset").onclick = () => { ta.value = ov.defaultTemplate; preview(); };
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

/* ---------------- data ---------------- */
function buildData() {
  $("#abody").innerHTML = `
  <div class="panel"><h3 style="margin:0 0 6px">개인정보 삭제</h3>
    <p style="font-size:14px;color:#3a433d;margin:0 0 12px">낙찰 안내가 끝나면 수집한 휴대폰 번호를 모두 지워 주세요. 사번과 입찰 기록, 낙찰 결과는 남고 <b>번호만</b> 지워집니다. 참여자는 다시 로그인해야 합니다.</p>
    <button class="btn red sm" id="purge">휴대폰 번호 전체 삭제</button></div>
  <div class="panel" style="margin-top:16px"><h3 style="margin:0 0 6px">전체 초기화</h3>
    <p style="font-size:14px;color:#3a433d;margin:0 0 12px">물품, 사진, 입찰, 문자 기록을 모두 지웁니다. 테스트를 마치고 실제 행사를 시작하기 전에 사용하세요.</p>
    <button class="btn red sm" id="reset">전체 초기화</button></div>`;
  $("#purge").onclick = async () => {
    if (!(await modal({ title: "휴대폰 번호 전체 삭제", body: "모든 참여자의 휴대폰 번호를 삭제합니다.\n되돌릴 수 없습니다. 먼저 ‘낙찰 결과’에서 낙찰 결과·참여자 명단 CSV를 받아 두세요.", ok: "삭제", danger: true }))) return;
    try { await api("/api/admin/purge-personal", { method: "POST" }); toast("삭제되었습니다"); await load(); refresh(); } catch (e) { toast(e.message); }
  };
  $("#reset").onclick = async () => {
    const v = await modal({ title: "전체 초기화", body: "모든 데이터를 삭제합니다. 계속하려면 아래에 ‘전체삭제’를 입력하세요.", ok: "초기화", danger: true, input: "전체삭제" });
    if (v == null) return;
    if (v !== "전체삭제") return toast("확인 문구가 일치하지 않습니다");
    try { await api("/api/admin/reset-all", { method: "POST", body: JSON.stringify({ confirm: v }) }); toast("초기화되었습니다"); await load(); refresh(); } catch (e) { toast(e.message); }
  };
}

/* ---------------- image ---------------- */
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
