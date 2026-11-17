// 테스트 전용: "cloudflare:workers" 를 로컬 모의 모듈로 바꿔 줍니다.
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
