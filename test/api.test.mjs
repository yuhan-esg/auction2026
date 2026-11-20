// 서버 로직 테스트: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx } from "./mock-cf.mjs";
const { Auction } = await import("../src/auction.js");

const env = { ADMIN_USERS: "170962:01046233945, 240022:010-5458-3721,071721:01090504601,110771:01054583721", SMS_MODE: "dry-run", EVENT_NAME: "테스트 경매", ANTI_SNIPE_SECONDS: "0" };
function setup(e = env) {
  const ctx = makeCtx();
  const d = new Auction(ctx, e);
  const call = async (method, path, body, headers = {}) => {
    const r = await d.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }));
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
  };
  let adminTok;
  const admin = async (m, p, b) => {
    if (!adminTok) adminTok = (await call("POST", "/api/login", { emp: "170962", phone: "01046233945", agree: true })).body.token;
    return call(m, "/api/admin" + p, b, { authorization: "Bearer " + adminTok });
  };
  const login = async (emp, phone = "01012345678") => {
    const r = await call("POST", "/api/login", { emp, phone, agree: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (m, p, b) => call(m, p, b, { authorization: "Bearer " + r.body.token });
  };
  return { d, ctx, call, admin, login };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("로그인 형식 검사", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/login", { emp: "12345", phone: "01012345678", agree: true })).status, 400);
  assert.equal((await call("POST", "/api/login", { emp: "123456", phone: "0212345678", agree: true })).status, 400);
  assert.equal((await call("POST", "/api/login", { emp: "123456", phone: "01012345678" })).status, 400);
  const ok = await call("POST", "/api/login", { emp: "123456", phone: "010-1234-5678", agree: true });
  assert.equal(ok.status, 200);
  assert.match(ok.body.token, /^[0-9a-f]{48}$/);
});

test("관리자 인증: 지정된 4명(사번+번호 일치)만", async () => {
  const { call, d } = setup();
  assert.equal((await call("GET", "/api/admin/overview")).status, 401);
  const tryAs = async (emp, phone) => {
    const l = (await call("POST", "/api/login", { emp, phone, agree: true })).body;
    const r = await call("GET", "/api/admin/overview", null, { authorization: "Bearer " + l.token });
    return [l.isAdmin, r.status];
  };
  assert.deepEqual(await tryAs("170962", "01046233945"), [true, 200]);
  assert.deepEqual(await tryAs("240022", "01054583721"), [true, 200]);
  assert.deepEqual(await tryAs("071721", "010-9050-4601"), [true, 200]);
  assert.deepEqual(await tryAs("110771", "01054583721"), [true, 200]);
  assert.deepEqual(await tryAs("170962", "01011112222"), [false, 403], "사번 맞고 번호 틀리면 일반 참여자");
  assert.deepEqual(await tryAs("123456", "01046233945"), [false, 403]);
  const l = (await call("POST", "/api/login", { emp: "071721", phone: "01090504601", agree: true })).body;
  d.env = { ...d.env, ADMIN_USERS: "170962:01046233945" };
  assert.equal((await call("GET", "/api/admin/overview", null, { authorization: "Bearer " + l.token })).status, 403, "명단에서 빠지면 바로 권한 해제");
  assert.equal((await call("GET", "/api/me", null, { authorization: "Bearer " + l.token })).body.isAdmin, false);
});

test("상세 사진: 추가, 순서 변경, 삭제", async () => {
  const { admin, call } = setup();
  const id = (await admin("POST", "/items", { no: 1, name: "A", start: 1000, step: 100, endAt: Date.now() + 60000 })).body.id;
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await admin("POST", `/items/${id}/photos`, { dataUrl: px })).body.id);
  let det = (await call("GET", "/api/items/" + id)).body;
  assert.deepEqual(det.photos, ids);
  assert.equal(det.item.photoVer, 3);
  await admin("PUT", `/items/${id}/photos/order`, { ids: [ids[2], ids[0], ids[1]] });
  await admin("DELETE", "/photos/" + ids[0]);
  det = (await call("GET", "/api/items/" + id)).body;
  assert.deepEqual(det.photos, [ids[2], ids[1]]);
  const img = await (await import("../src/auction.js")).Auction;
  assert.equal((await call("GET", "/api/photo/" + ids[2])).status, 200);
  assert.equal((await call("GET", "/api/photo/" + ids[0])).status, 404);
  assert.equal((await call("POST", "/api/admin/items/" + id + "/photos", { dataUrl: px })).status, 401, "로그인 없이 업로드 불가");
});

test("입찰 규칙: 최소가, 최고가 중복, 종료 후 차단, 낙찰 + 문자 미리보기", async () => {
  const { admin, login, call, d, ctx } = setup();
  const end = Date.now() + 1500;
  const c = await admin("POST", "/items", { no: 1, name: "스피커", start: 10000, step: 1000, endAt: end });
  assert.equal(c.status, 200);
  const id = c.body.id;
  assert.equal(ctx.alarmAt, end, "종료 시각에 알람 예약");
  const a = await login("111111", "01011112222");
  const b = await login("222222", "01033334444");

  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 9000 })).status, 409, "시작가 미만 거절");
  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 10000 })).status, 200, "시작가 입찰");
  await sleep(1001);
  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 20000 })).body.code, "already_top", "본인이 최고가면 거절");
  const low = await b("POST", "/api/bid", { itemId: id, amount: 10500 });
  assert.equal(low.status, 409); assert.equal(low.body.minNext, 11000);
  assert.equal((await b("POST", "/api/bid", { itemId: id, amount: 15000 })).status, 200);
  assert.equal((await b("POST", "/api/bid", { itemId: id, amount: 99999 })).status, 429, "1초 내 연속 입찰 제한");

  const st = (await call("GET", "/api/state")).body;
  assert.equal(st.items[0].top.amount, 15000);
  assert.equal(st.items[0].top.emp, "22**22", "사번 가림");
  assert.equal(st.items[0].minNext, 16000);
  assert.ok(!JSON.stringify(st).includes("0103333"), "공개 상태에 전화번호 없음");

  await sleep(end - Date.now() + 20);
  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 50000 })).body.code, "closed", "종료 후 입찰 차단");
  await d.alarm();
  const ov = (await admin("GET", "/overview")).body;
  assert.equal(ov.items[0].status, "sold");
  assert.equal(ov.items[0].winner.emp, "222222");
  assert.equal(ov.items[0].winner.phone, "010-3333-4444");
  assert.equal(ov.sms.length, 1);
  assert.equal(ov.sms[0].status, "preview", "테스트 모드에서는 보내지 않음");
  assert.equal(ov.sms[0].to_phone, "010-3333-4444");
  assert.match(ov.sms[0].text, /스피커 물품이 15,000원/);
  assert.equal(ctx.alarmAt, null, "남은 경매 없으면 알람 해제");
  await d.alarm();
  assert.equal((await admin("GET", "/overview")).body.sms.length, 1, "알람이 두 번 울려도 문자는 한 번");
});

test("유찰, 재오픈, 동시 입찰 순서", async () => {
  const { admin, login, d } = setup();
  const id = (await admin("POST", "/items", { no: 1, name: "A", start: 1000, step: 100, endAt: Date.now() + 300 })).body.id;
  await sleep(350); await d.alarm();
  let ov = (await admin("GET", "/overview")).body;
  assert.equal(ov.items[0].status, "unsold"); assert.equal(ov.sms.length, 0);
  await admin("PUT", "/items/" + id, { endAt: Date.now() + 60000 });
  ov = (await admin("GET", "/overview")).body;
  assert.equal(ov.items[0].status, "live", "종료 시각을 미래로 바꾸면 다시 진행");
  const users = await Promise.all(["300001", "300002", "300003"].map((e) => login(e)));
  const res = await Promise.all(users.map((u) => u("POST", "/api/bid", { itemId: id, amount: 1000 })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409, 409], "같은 금액 동시 입찰은 한 건만 성공");
});

test("마감 직전 연장(옵션)", async () => {
  const { admin, login, call } = setup({ ...env, ANTI_SNIPE_SECONDS: "60" });
  const end = Date.now() + 10000;
  const id = (await admin("POST", "/items", { no: 1, name: "A", start: 1000, step: 100, endAt: end })).body.id;
  const a = await login("400001");
  const r = await a("POST", "/api/bid", { itemId: id, amount: 1000 });
  assert.equal(r.body.extended, true);
  assert.ok((await call("GET", "/api/state")).body.items[0].endAt > end + 40000);
});

test("관리자: 입찰 취소, CSV, 개인정보 삭제, 문구 미리보기", async () => {
  const { admin, login } = setup();
  const id = (await admin("POST", "/items", { no: 7, name: "머플러", start: 1000, step: 100, endAt: Date.now() + 60000 })).body.id;
  assert.equal((await admin("POST", "/items", { no: 7, name: "중복", start: 1, step: 1, endAt: Date.now() + 1 })).status, 409);
  const a = await login("500001", "01055556666");
  await a("POST", "/api/bid", { itemId: id, amount: 1000000 });
  const bids = (await admin("GET", `/items/${id}/bids`)).body.bids;
  assert.equal(bids.length, 1);
  assert.equal((await admin("DELETE", "/bids/" + bids[0].id)).status, 200);
  assert.equal((await admin("GET", "/overview")).body.items[0].bidCount, 0);
  await sleep(1001);
  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 1000 })).status, 200);
  const part = (await admin("GET", "/export.csv?type=participants")).body;
  assert.match(part, /"500001","010-5555-6666",.*,"1","0",""/);
  assert.match(part, /"170962","010-4623-3945",.*"O"/);
  const csv = (await admin("GET", "/export.csv?type=bids")).body;
  assert.match(csv, /500001/);
  await admin("POST", "/purge-personal");
  assert.doesNotMatch((await admin("GET", "/export.csv?type=bids")).body, /010-5555/);
  assert.equal((await a("GET", "/api/me")).status, 401, "삭제 후 재로그인 필요");
  const pv = (await admin("POST", "/sms-preview", { template: "{물품명} {낙찰가}" })).body;
  assert.equal(pv.text, "예시 물품 50,000원"); assert.equal(pv.type, "SMS");
});

test("live 모드라도 솔라피 설정이 없으면 보내지 않고 실패로 기록", async () => {
  const { admin, login, d } = setup({ ...env, SMS_MODE: "live" });
  const id = (await admin("POST", "/items", { no: 1, name: "A", start: 1000, step: 100, endAt: Date.now() + 400 })).body.id;
  const a = await login("600001");
  await a("POST", "/api/bid", { itemId: id, amount: 1000 });
  await sleep(450); await d.alarm();
  const s = (await admin("GET", "/overview")).body.sms[0];
  assert.equal(s.status, "failed"); assert.match(s.detail, /SOLAPI_API_KEY/);
});

test("샘플 물품: 개수·상태 골라 넣기, 자동 낙찰, 문자는 실제 발송 안 함, 샘플만 삭제", async () => {
  let fetched = 0;
  const realFetch = globalThis.fetch; globalThis.fetch = async (...a) => { fetched++; return realFetch(...a); };
  try {
    const { admin, call, d } = setup({ ...env, SMS_MODE: "live", SOLAPI_API_KEY: "k", SOLAPI_API_SECRET: "s", SMS_FROM: "0212345678" });
    await admin("POST", "/items", { no: 1, name: "진짜 물품", start: 1000, step: 100, endAt: Date.now() + 60000 });
    const r = await admin("POST", "/samples", { count: 6, status: "mix" });
    assert.equal(r.body.items.length, 6);
    assert.equal(r.body.items[0].no, 2, "기존 번호 다음부터");
    assert.deepEqual(r.body.items.map((x) => x.status), ["ready", "live", "done", "ready", "live", "done"]);
    assert.equal((await admin("POST", "/samples", { count: 2, status: "done" })).body.items.length, 2, "여러 번 넣을 수 있음");
    await d.alarm();
    const ov = (await admin("GET", "/overview")).body;
    assert.equal(ov.items.filter((i) => i.status === "sold").length, 4, "완료 4개는 낙찰");
    assert.equal(ov.items.filter((i) => i.sample && i.status === "live" && i.bidCount === 0).length, 2, "준비중은 입찰 없음");
    assert.ok(ov.sms.length === 4 && ov.sms.every((x) => x.status === "preview" && x.mode === "sample"));
    assert.equal(fetched, 0, "솔라피 호출 없음");
    const sold = ov.items.find((i) => i.status === "sold");
    const pv = (await admin("POST", "/sms-preview", { template: "{물품명}/{사번}", itemId: sold.id })).body;
    assert.equal(pv.text, sold.name + "/" + sold.winner.emp);
    assert.equal(pv.to.state, "sold");
    const roster = (await admin("GET", "/roster")).body.rows;
    assert.ok(roster.some((x) => x.state === "won") && roster.some((x) => x.state === "leading"));
    assert.match((await admin("GET", "/export.csv?type=roster")).body, /"낙찰완료"/);
    assert.equal((await admin("DELETE", "/samples")).body.deleted, 8);
    assert.deepEqual((await call("GET", "/api/state")).body.items.map((i) => i.name), ["진짜 물품"]);
  } finally { globalThis.fetch = realFetch; }
});

test("희망가: 시작 전에만, 1인 1개 수정/취소, 금액 비공개, 관리자 통계", async () => {
  const { admin, login, call } = setup();
  const id = (await admin("POST", "/items", { no: 1, name: "A", start: 0, step: 1000, endAt: Date.now() + 86400000 })).body.id;
  const a = await login("700001"), b = await login("700002"), c = await login("700003");
  assert.equal((await a("POST", "/api/wish", { itemId: id, amount: 30000 })).body.code, "wish_closed", "시작 시각 없으면 접수 안 함");
  await admin("PUT", "/schedule", { startAt: Date.now() + 3600000 });
  assert.equal((await a("POST", "/api/wish", { itemId: id, amount: 30000 })).status, 200);
  assert.equal((await a("POST", "/api/wish", { itemId: id, amount: 41000 })).status, 429, "1초 안에 연속 불가");
  await sleep(1001);
  assert.equal((await a("POST", "/api/wish", { itemId: id, amount: 40000 })).status, 200, "수정");
  await b("POST", "/api/wish", { itemId: id, amount: 20000 });
  await c("POST", "/api/wish", { itemId: id, amount: 9000000 });
  const pub = (await call("GET", "/api/state")).body;
  assert.equal(pub.items[0].wishCount, 3);
  assert.ok(!JSON.stringify(pub).includes("40000") && !JSON.stringify(pub).includes("9000000"), "금액은 공개 안 됨");
  assert.equal(pub.schedule.wishOpen, true); assert.equal(pub.schedule.started, false);
  assert.deepEqual((await a("GET", "/api/my")).body.wishes, { [id]: 40000 });
  const w = (await admin("GET", "/overview")).body.items[0].wish;
  assert.deepEqual(w, { count: 3, avg: 3020000, median: 40000, min: 20000, max: 9000000 });
  await sleep(1001);
  await c("POST", "/api/wish", { itemId: id, amount: null });
  assert.equal((await admin("GET", "/overview")).body.items[0].wish.count, 2, "취소");
  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 50000 })).body.code, "not_started", "시작 전 입찰 불가");
  assert.match((await admin("GET", "/export.csv?type=wishes")).body, /"700001","40000"/);
  await admin("PUT", "/schedule", { startAt: Date.now() + 3600000, wishEndAt: Date.now() - 1 });
  assert.equal((await b("POST", "/api/wish", { itemId: id, amount: 1 })).body.code, "wish_closed", "희망가 마감 후");
  await admin("PUT", "/schedule", { startAt: Date.now() - 1 });
  assert.equal((await call("GET", "/api/state")).body.schedule.started, true);
  const r = await a("POST", "/api/bid", { itemId: id, amount: 500 });
  assert.equal(r.body.minNext, 1000, "시작가 0이면 입찰 단위부터");
  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 1000 })).status, 200);
});

test("30초 리셋: 기본값 30, 무제한 연장, 관리자 설정으로 변경", async () => {
  const { admin, login, call } = setup({ ...env, ANTI_SNIPE_SECONDS: undefined });
  const end = Date.now() + 20000; // 20초 남음
  const id = (await admin("POST", "/items", { no: 1, name: "A", start: 1000, step: 100, endAt: end })).body.id;
  const a = await login("800001"), b = await login("800002");
  assert.equal((await call("GET", "/api/state")).body.schedule.extendSeconds, 30);
  await a("POST", "/api/bid", { itemId: id, amount: 1000 });
  let it = (await call("GET", "/api/state")).body.items[0];
  assert.ok(it.endAt > end + 9000 && it.endAt <= Date.now() + 30000, "남은 시간이 30초로 리셋");
  assert.equal(it.extended, true); assert.equal(it.baseEndAt, end);
  const e1 = it.endAt;
  await sleep(300);
  await b("POST", "/api/bid", { itemId: id, amount: 1100 });
  it = (await call("GET", "/api/state")).body.items[0];
  assert.ok(it.endAt > e1, "또 연장 (제한 없음)");
  // 30초 넘게 남은 입찰은 연장 안 함
  const id2 = (await admin("POST", "/items", { no: 2, name: "B", start: 1000, step: 100, endAt: Date.now() + 60000 })).body.id;
  await sleep(1001);
  await a("POST", "/api/bid", { itemId: id2, amount: 1000 });
  assert.equal((await call("GET", "/api/state")).body.items[1].extended, false);
  await admin("PUT", "/schedule", { extendSeconds: 0 });
  assert.equal((await call("GET", "/api/state")).body.schedule.extendSeconds, 0);
});

test("물품별 입찰 버튼 금액 4개", async () => {
  const { admin, login, call } = setup();
  const id = (await admin("POST", "/items", { no: 1, name: "A", start: 50000, raises: [50000, 5000, 30000, 10000], endAt: Date.now() + 60000 })).body.id;
  const it = (await call("GET", "/api/state")).body.items[0];
  assert.deepEqual(it.raises, [5000, 10000, 30000, 50000], "작은 순으로 정렬");
  assert.equal((await admin("POST", "/items", { no: 2, name: "B", start: 0, raises: [1000, 0, 2, 3], endAt: Date.now() + 1 })).status, 400);
  const dflt = (await admin("POST", "/items", { no: 3, name: "C", start: 0, endAt: Date.now() + 60000 })).body.id;
  assert.deepEqual((await call("GET", "/api/items/" + dflt)).body.item.raises, [1000, 3000, 5000, 10000], "기본값");
  const a = await login("900101");
  await a("POST", "/api/bid", { itemId: id, amount: 50000 });
  assert.equal((await call("GET", "/api/items/" + id)).body.item.minNext, 55000, "다음 최소 = 가장 작은 버튼");
  await admin("PUT", "/items/" + id, { raises: [10000, 20000, 30000, 40000] });
  assert.equal((await call("GET", "/api/items/" + id)).body.item.minNext, 60000);
});


test("보안: 관리자 PIN, 잠금, PIN 변경 시 권한 해제, 기기 5개 제한, 공개 응답에 개인정보 없음", async () => {
  const { call, d } = setup({ ...env, ADMIN_PIN: "482913" });
  const L = (b) => call("POST", "/api/login", { agree: true, ...b });
  // 일반 로그인으로는 관리자가 안 됨
  const plain = (await L({ emp: "170962", phone: "01046233945" })).body;
  assert.equal(plain.isAdmin, false);
  assert.equal((await call("GET", "/api/admin/overview", null, { authorization: "Bearer " + plain.token })).status, 403);
  // 틀린 PIN 5번 → 잠금
  for (let i = 0; i < 5; i++) assert.equal((await L({ emp: "170962", phone: "01046233945", admin: true, pin: "000000" })).status, 403);
  const locked = await L({ emp: "170962", phone: "01046233945", admin: true, pin: "482913" });
  assert.equal(locked.status, 429, "맞는 PIN이어도 잠금 중엔 불가");
  d.run(`DELETE FROM admin_fail`);
  const ok = (await L({ emp: "170962", phone: "01046233945", admin: true, pin: "482913" })).body;
  assert.equal(ok.isAdmin, true);
  assert.equal((await call("GET", "/api/admin/overview", null, { authorization: "Bearer " + ok.token })).status, 200);
  // PIN을 바꾸면 기존 관리자 로그인 무효
  d.env = { ...d.env, ADMIN_PIN: "111111" };
  assert.equal((await call("GET", "/api/admin/overview", null, { authorization: "Bearer " + ok.token })).status, 403);
  // 같은 사번 기기 5개까지만
  const toks = [];
  for (let i = 0; i < 7; i++) { toks.push((await L({ emp: "555555", phone: "01055555555" })).body.token); await sleep(2); }
  const alive = [];
  for (const t of toks) alive.push((await call("GET", "/api/me", null, { authorization: "Bearer " + t })).status);
  assert.deepEqual(alive, [401, 401, 200, 200, 200, 200, 200]);
  // 공개 응답엔 전화번호 없음
  const st = JSON.stringify((await call("GET", "/api/state")).body);
  assert.ok(!/010\d{8}|010-\d{4}/.test(st));
  // 이상한 토큰 / SQL 같은 입력
  assert.equal((await call("GET", "/api/me", null, { authorization: "Bearer ' OR 1=1 --" })).status, 401);
  assert.equal((await call("GET", "/api/items/x'%20OR%201=1")).status, 404);
});

test("같은 금액 동시 입찰 안내, 공지, 관리자 작업 기록", async () => {
  const { admin, login, call } = setup();
  const id = (await admin("POST", "/items", { no: 1, name: "머플러", start: 30000, raises: [1000, 3000, 5000, 10000], endAt: Date.now() + 60000 })).body.id;
  const a = await login("910001"), b = await login("910002");
  assert.equal((await a("POST", "/api/bid", { itemId: id, amount: 31000 })).status, 200);
  const r = await b("POST", "/api/bid", { itemId: id, amount: 31000 });
  assert.equal(r.body.code, "same_amount");
  assert.match(r.body.error, /같은 금액\(31,000원\)이 .* 먼저 들어왔어요/);
  // 공지: 기본 안내가 상태에 실려 감, 관리자가 바꾸면 바뀜, 비우면 숨김
  assert.match((await call("GET", "/api/state")).body.notice, /바로 입찰/);
  await admin("PUT", "/schedule", { notice: "담당자: 총무팀 (내선 1234)" });
  assert.equal((await call("GET", "/api/state")).body.notice, "담당자: 총무팀 (내선 1234)");
  await admin("PUT", "/schedule", { notice: "" });
  assert.equal((await call("GET", "/api/state")).body.notice, "");
  // 입찰 취소 → 기록에 누가, 어떤 입찰을
  const bid = (await admin("GET", `/items/${id}/bids`)).body.bids[0];
  await admin("DELETE", "/bids/" + bid.id);
  const log = (await admin("GET", "/log")).body.log;
  const cancel = log.find((x) => x.action === "입찰 취소");
  assert.equal(cancel.emp, "170962");
  assert.equal(cancel.item_name, "머플러");
  assert.match(cancel.detail, /사번 910001 · 31,000원/);
  assert.ok(log.some((x) => x.action === "물품 등록"));
  assert.ok(log.some((x) => x.action === "설정 변경" && /공지/.test(x.detail)));
  assert.equal((await a("GET", "/api/admin/log")).status, 403, "일반 참여자는 기록 못 봄");
});
