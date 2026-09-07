import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { searchAptSuggestions } = await import("../src/lib/molit/apt");
  for (const q of ["안양역한양", "한양수자인", "래미안", "안양한양수자인"]) {
    const t0 = Date.now();
    const s = await searchAptSuggestions(q, 8);
    console.log(
      JSON.stringify({
        q,
        ms: Date.now() - t0,
        n: s.length,
        top: s.slice(0, 3).map((x) => `${x.aptName}/${x.regionName}`),
      }),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
