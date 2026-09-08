import { config } from "dotenv";
config({ path: ".env.local" });
import {
  getMarketHome,
  readMarketHomeSnapshot,
} from "../src/lib/market/home";

async function time(label: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  const r = (await fn()) as { source?: string; kpis?: unknown };
  console.log(label, Date.now() - t0, "ms", r?.source, r?.kpis ?? "");
}

async function main() {
  await time("snapshot-read-1", () => readMarketHomeSnapshot());
  await time("snapshot-read-2", () => readMarketHomeSnapshot());
  await time("getMarketHome-1", () => getMarketHome());
  await time("getMarketHome-2-warm", () => getMarketHome());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
