export async function resolve(spec, ctx, next) {
  if (spec === "cloudflare:workers") return { url: new URL("./mock-cf.mjs", import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
