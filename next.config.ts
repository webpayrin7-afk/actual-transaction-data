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
  // AI 학습용 수집 거부 표시 — TDM 권리 유보(W3C TDMRep)와 noai 로봇 태그. 데이터 API는 색인도 막는다.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "tdm-reservation", value: "1" },
          { key: "X-Robots-Tag", value: "noai, noimageai" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noai, noimageai" }],
      },
    ];
  },
};

export default nextConfig;

// redeploy 20260907092517
// redeploy 2026-09-07T09:26:05Z

// secrets-redeploy 20260907093549

// secrets-retry 20260907093917

// token-redeploy 20260907094346

// token-redeploy-2 20260907094822
