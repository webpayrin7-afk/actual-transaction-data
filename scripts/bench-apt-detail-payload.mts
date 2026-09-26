// 단지 상세 응답 크기(원본·gzip·br)와 압축 형식 왕복 동일성 확인 (읽기 전용): npx tsx scripts/bench-apt-detail-payload.mts
import { config } from "dotenv";
config({ path: ".env.local" });
import { gzipSync, brotliCompressSync } from "node:zlib";

function sizes(s: string) {
  const b = Buffer.from(s);
  return { raw: b.length, gzip: gzipSync(b).length, br: brotliCompressSync(b).length };
}

async function main() {
  const { getAptDetail } = await import("../src/lib/molit/apt");
  const { packAptDetail, unpackAptDetail } = await import("../src/lib/molit/apt-detail-wire");
  const targets: [string, string, number][] = [
    ["헬리오시티", "seoul-songpa", 120],
    ["래미안원베일리", "seoul-seocho", 120],
    ["헬리오시티", "seoul-songpa", 36],
    ["안양역한양수자인리버파크", "gyeonggi-anyang", 120],
  ];
  let ok = true;
  for (const [aptName, regionSlug, months] of targets) {
    const t0 = Date.now();
    const d = await getAptDetail({ aptName, regionSlug, months });
    const ms = Date.now() - t0;
    if (!d) {
      console.log(aptName, "not found");
      continue;
    }
    let t = Date.now();
    const before = JSON.stringify(d);
    const serBefore = Date.now() - t;
    t = Date.now();
    const after = JSON.stringify(packAptDetail(d));
    const serAfter = Date.now() - t;
    t = Date.now();
    const restored = JSON.stringify(unpackAptDetail(JSON.parse(after)));
    const decodeMs = Date.now() - t;
    const same = restored === before;
    if (!same) ok = false;
    console.log(aptName, months, {
      getMs: ms,
      items: d.items.length,
      before: { ...sizes(before), serMs: serBefore },
      after: { ...sizes(after), serMs: serAfter },
      decodeMs,
      byteIdenticalAfterRoundtrip: same,
    });
  }
  if (!ok) process.exit(2);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
