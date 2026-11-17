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
  assert.match(ov.sms[0].text, /No\.1 스피커.*15,000원/);
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
