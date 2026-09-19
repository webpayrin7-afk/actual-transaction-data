/**
 * Apply the already-fixed wave manifest. One transaction per sido.
 * INSERT only. Existing master rows are not updated or deleted.
 *
 * Usage: node scripts/national-master/apply-wave.mjs --commit
 * Without --commit, precheck only.
 */
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const root = new URL("../../", import.meta.url);

function fileArg(flag, fallback) {
  const index = args.indexOf(flag);
  const rel = index >= 0 ? args[index + 1] : fallback;
  return new URL(rel, root);
}

const manifest = JSON.parse(readFileSync(fileArg("--manifest", "data/poc/national-master/wave1-manifest.json"), "utf8"));
const dry = JSON.parse(
  readFileSync(new URL("data/poc/national-master/national-dry-run.json", root), "utf8"),
);
const checkpointPath = fileArg("--checkpoint", "data/poc/national-master/wave1-checkpoint.json");
const resultPath = fileArg("--result", "data/poc/national-master/wave1-result.json");
const protectedRows = manifest.protected || [
  { sido: "서울특별시", n: 8437 },
  { sido: "경기도", n: 6529 },
];
const lawdPath = process.env.LAWD_RESOLVER;
if (!lawdPath) throw new Error("LAWD_RESOLVER is required");

function complexId(lawd, norm) {
  return "cx_" + createHash("sha1").update(`molit:${lawd}:${norm}`, "utf8").digest("hex").slice(0, 16);
}

if (complexId("11260", "sg타워") !== "cx_0000802f1c42d195") {
  throw new Error("complex_id rule drift");
}

function activeSets(path) {
  const sigungu = new Set();
  const legal = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.status !== "active") continue;
    if (row.level === "sigungu" && row.sigungu_code) sigungu.add(row.sigungu_code);
    if (row.full_legal_code) legal.add(row.full_legal_code);
  }
  return { sigungu, legal };
}

const active = activeSets(lawdPath);
for (const wave of manifest.waves) {
  if (wave.inserts.length !== wave.expected_inserts) {
    throw new Error(`expected insert drift ${wave.sido}`);
  }
  const ids = new Set();
  const keys = new Set();
  for (const row of wave.inserts) {
    if (ids.has(row.complex_id) || keys.has(row.source_key)) {
      throw new Error(`duplicate plan ${wave.sido} ${row.source_key}`);
    }
    ids.add(row.complex_id);
    keys.add(row.source_key);
    if (complexId(row.lawd_cd, row.apt_name_norm) !== row.complex_id) {
      throw new Error(`id rule ${row.source_key}`);
    }
    if (!active.sigungu.has(row.lawd_cd) || !active.legal.has(row.full_legal_code)) {
      throw new Error(`inactive lawd ${row.source_key}`);
    }
    if (row.sido_code === "11" || row.sido_code === "41") {
      throw new Error(`capital insert blocked ${row.source_key}`);
    }
    if (!row.apt_name || !row.apt_name_norm || !/^A\d{8}$/.test(row.source_key)) {
      throw new Error(`invalid identity ${row.source_key}`);
    }
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function scalar(sql, args = []) {
  const rs = await db.execute({ sql, args });
  return Number(rs.rows[0].n);
}

async function capitalHash() {
  const rs = await db.execute(
    "SELECT complex_id, apt_name_norm, lawd_cd FROM apt_complex_master WHERE sido_code IN ('11','41') ORDER BY complex_id",
  );
  const digest = createHash("sha256");
  for (const row of rs.rows) {
    digest.update(`${row.complex_id}|${row.apt_name_norm}|${row.lawd_cd}\n`);
  }
  return { n: rs.rows.length, sha256: digest.digest("hex") };
}

async function presentIds(ids) {
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_complex_master WHERE complex_id IN (${ph})`,
      args: chunk,
    });
    n += Number(rs.rows[0].n);
  }
  return n;
}

async function presentKeys(keys) {
  let n = 0;
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_complex_source_links WHERE source = 'KAPT' AND source_key IN (${ph})`,
      args: chunk,
    });
    n += Number(rs.rows[0].n);
  }
  return n;
}

let checkpoint = { completed: [], failed: null };
try {
  checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
} catch {
  checkpoint = { completed: [], failed: null };
}

const beforeCapital = await capitalHash();
const live = {
  master: await scalar("SELECT COUNT(*) AS n FROM apt_complex_master"),
  seoul: await scalar("SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido = '서울특별시'"),
  gyeonggi: await scalar("SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido = '경기도'"),
  kapt_links: await scalar("SELECT COUNT(*) AS n FROM apt_complex_source_links WHERE source = 'KAPT'"),
};
const insertedSoFar = checkpoint.completed.reduce((sum, row) => sum + row.inserted, 0);
const expectedMaster = manifest.initial.master + insertedSoFar;
async function assertProtected(exec) {
  for (const row of protectedRows) {
    const rs = await exec({
      sql: "SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido = ?",
      args: [row.sido],
    });
    if (Number(rs.rows[0].n) !== row.n) {
      throw new Error(`protected drift ${row.sido} ${rs.rows[0].n} expected ${row.n}`);
    }
  }
}

async function protectedDigest(exec) {
  const sidos = protectedRows.map((row) => row.sido);
  const ph = sidos.map(() => "?").join(",");
  const rs = await exec({
    sql: `SELECT complex_id, apt_name_norm, lawd_cd FROM apt_complex_master WHERE sido IN (${ph}) ORDER BY complex_id`,
    args: sidos,
  });
  const digest = createHash("sha256");
  for (const row of rs.rows) {
    digest.update(`${row.complex_id}|${row.apt_name_norm}|${row.lawd_cd}\n`);
  }
  return { n: rs.rows.length, sha256: digest.digest("hex") };
}

if (live.seoul !== 8437 || live.gyeonggi !== 6529) {
  throw new Error(`capital drift seoul ${live.seoul} gyeonggi ${live.gyeonggi}`);
}
await assertProtected((query) => db.execute(query));
const beforeProtected = await protectedDigest((query) => db.execute(query));
if (live.master !== expectedMaster) {
  throw new Error(`master drift ${live.master} expected ${expectedMaster}`);
}
if (beforeCapital.n !== 14966) {
  throw new Error(`capital hash rows ${beforeCapital.n}`);
}

const stamp = new Date().toISOString();
const results = [];

function remaining() {
  const done = new Set([
    ...protectedRows.map((row) => row.sido),
    ...checkpoint.completed.map((row) => row.sido),
  ]);
  return (dry.wave_rejected_or_deferred || [])
    .filter((row) => row.reason === "deferred_rank")
    .map((row) => row.sido)
    .filter((sido) => !done.has(sido));
}

if (!commit) {
  process.stdout.write(
    JSON.stringify({
      status: "PRECHECK_OK",
      live,
      capital_rows: beforeCapital.n,
      waves: manifest.waves.map((wave) => ({ sido: wave.sido, expected_inserts: wave.expected_inserts })),
    }) + "\n",
  );
  process.exit(0);
}

for (const wave of manifest.waves) {
  if (checkpoint.completed.some((row) => row.sido === wave.sido)) continue;
  const ids = wave.inserts.map((row) => row.complex_id);
  const keys = wave.inserts.map((row) => row.source_key);
  const haveIds = await presentIds(ids);
  const haveKeys = await presentKeys(keys);
  if (haveIds === wave.expected_inserts && haveKeys === wave.expected_inserts) {
    checkpoint.completed.push({
      sido: wave.sido,
      inserted: wave.expected_inserts,
      kapt_links: wave.expected_inserts,
      resumed: true,
    });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");
    continue;
  }
  if (haveIds !== 0 || haveKeys !== 0) {
    throw new Error(`partial ${wave.sido} ids ${haveIds} keys ${haveKeys}`);
  }

  const tx = await db.transaction("write");
  try {
    let masterAffected = 0;
    let linkAffected = 0;
    for (let i = 0; i < wave.inserts.length; i += 25) {
      const chunk = wave.inserts.slice(i, i + 25);
      const masterPh = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
      const masterArgs = [];
      for (const row of chunk) {
        masterArgs.push(
          row.complex_id,
          row.apt_name,
          row.apt_name_norm,
          row.sido,
          row.sido_code,
          row.sigungu,
          row.lawd_cd,
          row.legal_dong_name,
          row.bjdong_cd,
          null,
          row.road_address || null,
          null,
          null,
          "IDENTITY-READY",
          "[]",
          stamp,
          stamp,
        );
      }
      const masterRs = await tx.execute({
        sql: `INSERT INTO apt_complex_master (
          complex_id, apt_name, apt_name_norm, sido, sido_code, sigungu, lawd_cd,
          legal_dong_name, bjdong_cd, jibun, road_address, latitude, longitude,
          identity_status, identity_reason_codes, created_at, updated_at
        ) VALUES ${masterPh}`,
        args: masterArgs,
      });
      masterAffected += Number(masterRs.rowsAffected ?? 0);
      const linkPh = chunk.map(() => "(?,?,?,?,?,?,?)").join(",");
      const linkArgs = [];
      for (const row of chunk) {
        linkArgs.push(
          "KAPT",
          row.source_key,
          row.complex_id,
          JSON.stringify({
            lawd_cd: row.lawd_cd,
            full_legal_code: row.full_legal_code,
            apt_name_norm: row.apt_name_norm,
          }),
          row.source_version,
          stamp,
          stamp,
        );
      }
      const linkRs = await tx.execute({
        sql: `INSERT INTO apt_complex_source_links (
          source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at
        ) VALUES ${linkPh}`,
        args: linkArgs,
      });
      linkAffected += Number(linkRs.rowsAffected ?? 0);
    }
    if (masterAffected !== wave.expected_inserts || linkAffected !== wave.expected_inserts) {
      throw new Error(`affected master ${masterAffected} links ${linkAffected} expected ${wave.expected_inserts}`);
    }
    const seoul = await tx.execute("SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido = '서울특별시'");
    const gyeonggi = await tx.execute("SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido = '경기도'");
    const total = await tx.execute("SELECT COUNT(*) AS n FROM apt_complex_master");
    const dupId = await tx.execute(
      "SELECT COUNT(*) AS n FROM (SELECT complex_id FROM apt_complex_master GROUP BY complex_id HAVING COUNT(*) > 1)",
    );
    const dupKey = await tx.execute(
      "SELECT COUNT(*) AS n FROM (SELECT source, source_key FROM apt_complex_source_links GROUP BY source, source_key HAVING COUNT(*) > 1)",
    );
    if (Number(seoul.rows[0].n) !== 8437 || Number(gyeonggi.rows[0].n) !== 6529) {
      throw new Error("capital count changed inside transaction");
    }
    if (Number(total.rows[0].n) !== live.master + masterAffected) {
      throw new Error(`total ${total.rows[0].n}`);
    }
    if (Number(dupId.rows[0].n) !== 0 || Number(dupKey.rows[0].n) !== 0) {
      throw new Error("duplicate identity inside transaction");
    }
    await assertProtected((query) => tx.execute(query));
    const insideProtected = await protectedDigest((query) => tx.execute(query));
    if (insideProtected.sha256 !== beforeProtected.sha256 || insideProtected.n !== beforeProtected.n) {
      throw new Error("existing rows changed inside transaction");
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    tx.close();
    checkpoint.failed = { sido: wave.sido, error: String(error.message || error) };
    writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");
    throw error;
  }
  tx.close();

  const afterCapital = await capitalHash();
  if (afterCapital.sha256 !== beforeCapital.sha256 || afterCapital.n !== 14966) {
    throw new Error(`existing rows changed after ${wave.sido}`);
  }
  live.master += wave.expected_inserts;
  live.kapt_links += wave.expected_inserts;
  const done = {
    sido: wave.sido,
    sido_code: wave.sido_code,
    inserted: wave.expected_inserts,
    kapt_links: wave.expected_inserts,
    master_total: live.master,
    cadastral_source_available: wave.cadastral_source_available,
    coordinate_phase_ready: false,
  };
  checkpoint.completed.push(done);
  checkpoint.remaining = remaining().filter((sido) => !checkpoint.completed.some((row) => row.sido === sido));
  checkpoint.next_wave_ready = checkpoint.remaining.length > 0 && !checkpoint.failed;
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");
  results.push(done);
  process.stdout.write(`PASS ${wave.sido} ${wave.expected_inserts}\n`);
}

const finalCapital = await capitalHash();
const final = {
  master: await scalar("SELECT COUNT(*) AS n FROM apt_complex_master"),
  seoul: await scalar("SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido = '서울특별시'"),
  gyeonggi: await scalar("SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido = '경기도'"),
  kapt_links: await scalar("SELECT COUNT(*) AS n FROM apt_complex_source_links WHERE source = 'KAPT'"),
  dup_complex_id: await scalar(
    "SELECT COUNT(*) AS n FROM (SELECT complex_id FROM apt_complex_master GROUP BY complex_id HAVING COUNT(*) > 1)",
  ),
  dup_kapt: await scalar(
    "SELECT COUNT(*) AS n FROM (SELECT source_key FROM apt_complex_source_links WHERE source = 'KAPT' GROUP BY source_key HAVING COUNT(*) > 1)",
  ),
};
const bySido = await db.execute(
  "SELECT sido, COUNT(*) AS n FROM apt_complex_master GROUP BY sido ORDER BY n DESC",
);
const insertedThisWave = checkpoint.completed.reduce((sum, row) => sum + row.inserted, 0);
const result = {
  status: "PASS",
  stamp,
  capital_unchanged: finalCapital.sha256 === beforeCapital.sha256 && finalCapital.n === 14966,
  existing_rows_changed: finalCapital.sha256 === beforeCapital.sha256 ? 0 : 1,
  final,
  by_sido: bySido.rows,
  waves: checkpoint.completed,
  remaining_new_safe:
    typeof manifest.new_safe_remaining_before === "number"
      ? manifest.new_safe_remaining_before - insertedThisWave
      : null,
  coordinate_next: (manifest.coordinate_next || checkpoint.completed).map((row) => ({
    sido: row.sido,
    status: "BLOCKED",
    pnu_identity_input: "NO",
    cadastral_file: "NO",
    coordinate_dry_run_ready: "NO",
    blocker: row.blocker || "no staged PNU or cadastral parcel file; coordinate dry-run not run",
  })),
  next_wave_ready: checkpoint.next_wave_ready === true,
  remaining: checkpoint.remaining || remaining(),
};
writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
process.stdout.write(JSON.stringify({ status: "PASS", final, waves: result.waves.map((row) => row.sido) }) + "\n");
