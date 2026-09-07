import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phone/tunnel preview (Cloudflare Quick Tunnel) needs the public host allowlisted
  // so client fetches/HMR are not blocked as cross-origin in `next dev`.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "*.trycloudflare.com",
    "trycloudflare.com",
  ],
};

export default nextConfig;

// redeploy 20260907092517
// redeploy 2026-09-07T09:26:05Z

// secrets-redeploy 20260907093549

// secrets-retry 20260907093917

// token-redeploy 20260907094346

// token-redeploy-2 20260907094822
