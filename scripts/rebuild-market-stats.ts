import { config } from "dotenv";
config({ path: ".env.local" });
import { rebuildMarketStats } from "../src/lib/market/stats";

async function main() {
  const result = await rebuildMarketStats();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
