// Cloudflare Worker 진입점
// - /api/*  → 경매 Durable Object(한 개의 "main" 인스턴스)가 처리
// - 그 외   → public/ 폴더의 정적 파일(화면)
export { Auction } from "./auction.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const stub = env.AUCTION.get(env.AUCTION.idFromName("main"));
      const res = await stub.fetch(request);
      if (res.status === 101) return res; // 실시간 연결은 그대로
      const h = new Headers(res.headers);
      h.set("X-Content-Type-Options", "nosniff");
      h.set("X-Frame-Options", "DENY");
      h.set("Referrer-Policy", "no-referrer");
      h.set("X-Robots-Tag", "noindex, nofollow");
      return new Response(res.body, { status: res.status, headers: h });
    }
    return env.ASSETS.fetch(request);
  },
};
