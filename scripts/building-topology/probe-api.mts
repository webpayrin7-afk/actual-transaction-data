import { createClient } from "@libsql/client";
import { loadComplexBuildingsApi } from "@/lib/buildings/api";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const payload = await loadComplexBuildingsApi(db, "cx_4c63d9a100973c60");
if (!payload) throw new Error("missing jamsil");
const t8480 = payload.buildings.filter((b) =>
  b.unitTypes.some((t) => t.exclusiveArea === 84.8),
);
console.log(
  JSON.stringify({
    complexId: payload.complexId,
    status: payload.status,
    buildings: payload.buildings.length,
    withFootprint: payload.buildings.filter((b) => b.footprint).length,
    withPoint: payload.buildings.filter((b) => b.lat != null && b.lng != null).length,
    labeled: payload.buildings.filter((b) => b.dongLabel).length,
    type8480Buildings: t8480.length,
    sample: payload.buildings[0],
  }),
);
