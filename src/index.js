// Cloudflare Worker 진입점
// - /api/*  → 경매 Durable Object(한 개의 "main" 인스턴스)가 처리
// - 그 외   → public/ 폴더의 정적 파일(화면)
export { Auction } from "./auction.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const stub = env.AUCTION.get(env.AUCTION.idFromName("main"));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
