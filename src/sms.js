// 문자 발송 모듈
//
// SMS_MODE 가 "live" 가 아니면 실제로 보내지 않고 "미리보기(preview)"로만 기록합니다.
// 솔라피 계정이 준비되면 README 의 "문자 실제 발송 켜기" 순서를 따라 주세요.

export const DEFAULT_TEMPLATE =
  "[{행사명}] 축하합니다!\n{물품명} 물품이 {낙찰가}에 낙찰되었습니다.\n수령 및 기부금 납부 방법은 별도로 안내드리겠습니다.\n따뜻한 나눔에 감사드립니다.";

export function smsMode(env) {
  return env.SMS_MODE === "live" ? "live" : "dry-run";
}

export function renderTemplate(tpl, v) {
  const map = {
    "{행사명}": v.event ?? "",
    "{번호}": String(v.no ?? ""),
    "{물품명}": v.name ?? "",
    "{낙찰가}": Number(v.amount ?? 0).toLocaleString("ko-KR") + "원",
    "{사번}": v.emp ?? "",
  };
  return String(tpl || DEFAULT_TEMPLATE).replace(/\{(행사명|번호|물품명|낙찰가|사번)\}/g, (m) => map[m]);
}

// 한글 2byte, 그 외 1byte 기준 (통신사 SMS 기준 90byte 초과 시 LMS)
export function smsBytes(text) {
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @returns {Promise<{mode:string,status:"preview"|"sent"|"failed",detail:string}>}
 */
export async function sendSms(env, { to, text }) {
  const mode = smsMode(env);
  if (mode !== "live") {
    return { mode, status: "preview", detail: "테스트 모드 — 실제로 발송하지 않았습니다." };
  }
  const apiKey = env.SOLAPI_API_KEY, apiSecret = env.SOLAPI_API_SECRET, from = env.SMS_FROM;
  if (!apiKey || !apiSecret || !from) {
    return { mode, status: "failed", detail: "SOLAPI_API_KEY / SOLAPI_API_SECRET / SMS_FROM 설정이 필요합니다." };
  }
  try {
    const date = new Date().toISOString();
    const salt = crypto.randomUUID().replace(/-/g, "");
    const signature = await hmacHex(apiSecret, date + salt);
    const res = await fetch("https://api.solapi.com/messages/v4/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify({
        message: { to: to.replace(/\D/g, ""), from: from.replace(/\D/g, ""), text, autoTypeDetect: true },
      }),
    });
    const body = await res.text();
    if (!res.ok) return { mode, status: "failed", detail: `HTTP ${res.status} ${body.slice(0, 300)}` };
    return { mode, status: "sent", detail: body.slice(0, 300) };
  } catch (e) {
    return { mode, status: "failed", detail: String(e && e.message || e).slice(0, 300) };
  }
}
