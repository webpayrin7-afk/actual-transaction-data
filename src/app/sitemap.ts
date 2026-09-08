import type { MetadataRoute } from "next";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
  "https://actual-transaction-data.vercel.app";

const STATIC_PATHS = [
  "/",
  "/complexes",
  "/regions",
  "/stats",
  "/tools",
  "/loan",
  "/rates",
  "/about",
  "/guide",
  "/data-policy",
  "/faq",
  "/privacy",
  "/terms",
  "/contact",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return STATIC_PATHS.map((path) => ({
    url: `${BASE_URL}${path === "/" ? "" : path}`,
    lastModified,
    changeFrequency: path === "/" ? "daily" : "weekly",
    priority: path === "/" ? 1 : path.startsWith("/about") || path === "/guide" ? 0.8 : 0.6,
  }));
}
