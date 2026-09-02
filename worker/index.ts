/**
 * SharableWorlds on Cloudflare Workers.
 *
 * The site is a static export (`next build` → ./out). The Static Assets
 * binding serves every file; this handler only decides caching and adds
 * security headers — nothing is rendered here.
 *
 * Typed locally on purpose: pulling @cloudflare/workers-types into the root
 * tsconfig collides with the DOM lib the app itself needs.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Hashed build output and the art packs never change under the same path.
 * The catalog JSON does (rebuilt with the library), so it stays short-lived. */
const IMMUTABLE = [/^\/_next\/static\//, /^\/assets\/(?!.*\.json$)/];
/** HTML and the catalog: revalidate at the edge every minute, never stale for long. */
const SHORT = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
const FOREVER = "public, max-age=31536000, immutable";

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // The build emits no source maps; refuse the path shape anyway so a
    // future config change cannot expose source through this Worker.
    if (/\.map$/i.test(url.pathname)) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }

    const upstream = await env.ASSETS.fetch(request);
    const response = new Response(upstream.body, upstream);
    const headers = response.headers;
    headers.delete("sourcemap");
    headers.delete("x-sourcemap");

    if (response.ok) {
      headers.set("cache-control", IMMUTABLE.some((re) => re.test(url.pathname)) ? FOREVER : SHORT);
    }

    // Baseline hardening. The app needs WebGL and the Web Share API, both of
    // which are fine under these.
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("x-frame-options", "SAMEORIGIN");
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");

    return response;
  },
};

export default worker;
