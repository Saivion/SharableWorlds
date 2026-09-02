import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is entirely client-rendered (one page, WebMCP + Three.js in the
  // browser, share links as query strings on "/"), so it ships as a static
  // export. That is what the Cloudflare Worker in ./worker serves — see
  // wrangler.jsonc and docs/DEPLOY-CLOUDFLARE.md.
  output: "export",
  images: { unoptimized: true },
  // Never ship browser source maps: the deployed bundle is minified with no
  // *.map files and no sourceMappingURL comments. (Dev on :3000 keeps maps —
  // that is what makes stack traces readable while building.)
  productionBrowserSourceMaps: false,
  transpilePackages: ["three"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
