/**
 * 전국 버스정류장 (bus_stops, 국토교통부 전국 버스정류장 위치정보) + 경유 노선.
 * - 위치: DB, 좌표는 원천 그대로. 같은 정류장이 관리 BIS별로 두 번 실린 경우(서울BIS·경기BIS, 같은 모바일단축번호)는
 *   이름·단축번호가 같고 30m 안이면 하나로 묶는다.
 * - 노선: 서울 밖은 TAGO 정류소별 경유노선(getSttnThrghRouteList)을 필요할 때 조회(하루 캐시). 서울은 TAGO에 없어 아직 비운다.
 * 읽기 전용. 표가 없거나 실패하면 빈 목록.
 */
import type { Client } from "@libsql/client";
import { haversineMeters, type LatLng } from "@/lib/complex-detail/geo";

export type NearbyBusStop = {
  id: string;
  name: string;
  arsNo: string | null;
  lat: number;
  lng: number;
  distanceMeters: number;
  distanceLabel: string;
  /** 경유 노선 번호 — 모르면 빈 배열 */
  routes: string[];
};

const MERGE_METERS = 30;
const TAGO_BASE = "https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getSttnThrghRouteList";

function distanceLabel(m: number): string {
  if (m < 1000) return `직선거리 ${Math.round(m)}m`;
  return `직선거리 ${(m / 1000).toFixed(1)}km`;
}

let tableChecked: boolean | null = null;

async function taGoRoutes(cityCode: string, nodeId: string): Promise<string[]> {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key || cityCode === "11") return [];
  const qs = `serviceKey=${encodeURIComponent(key)}&cityCode=${encodeURIComponent(cityCode)}&nodeId=${encodeURIComponent(nodeId)}&numOfRows=100&pageNo=1&_type=json`;
  try {
    const res = await fetch(`${TAGO_BASE}?${qs}`, {
      next: { revalidate: 86_400 },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      response?: { body?: { items?: { item?: Array<{ routeno?: string | number }> | { routeno?: string | number } } | "" } };
    };
    const items = json.response?.body?.items;
    const list = !items || typeof items === "string" ? [] : Array.isArray(items.item) ? items.item : items.item ? [items.item] : [];
    const nos = [...new Set(list.map((x) => String(x.routeno ?? "").trim()).filter(Boolean))];
    return nos.sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  } catch {
    return [];
  }
}

/** 반경 안 정류장 (가까운 순, 최대 limit). 노선은 서울 밖만 채운다. */
export async function readNearbyBusStops(
  db: Client,
  center: LatLng,
  opts?: { maxMeters?: number; limit?: number },
): Promise<NearbyBusStop[]> {
  const maxMeters = opts?.maxMeters ?? 500;
  const limit = opts?.limit ?? 6;
  try {
    if (tableChecked !== true) {
      tableChecked =
        (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bus_stops'")).rows.length > 0;
    }
    if (!tableChecked) return [];
    const dLat = maxMeters / 111_320;
    const dLng = maxMeters / (111_320 * Math.cos((center.lat * Math.PI) / 180));
    const res = await db.execute({
      sql: `SELECT stop_id, name, lat, lng, ars_no, city_code FROM bus_stops
            WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
      args: [center.lat - dLat, center.lat + dLat, center.lng - dLng, center.lng + dLng],
    });
    const ranked = res.rows
      .map((r) => {
        const lat = Number(r.lat);
        const lng = Number(r.lng);
        return {
          id: String(r.stop_id),
          name: String(r.name),
          arsNo: r.ars_no == null || r.ars_no === "" ? null : String(r.ars_no),
          cityCode: r.city_code == null ? "" : String(r.city_code),
          lat,
          lng,
          d: Math.round(haversineMeters(center.lat, center.lng, lat, lng)),
        };
      })
      .filter((s) => s.d <= maxMeters)
      .sort((a, b) => a.d - b.d);

    const picked: typeof ranked = [];
    for (const s of ranked) {
      const dup = picked.some(
        (p) => p.name === s.name && p.arsNo === s.arsNo && haversineMeters(p.lat, p.lng, s.lat, s.lng) <= MERGE_METERS,
      );
      if (!dup) picked.push(s);
      if (picked.length >= limit) break;
    }
    const routes = await Promise.all(picked.map((s) => taGoRoutes(s.cityCode, s.id)));
    return picked.map((s, i) => ({
      id: `bus-${s.id}`,
      name: s.name,
      arsNo: s.arsNo,
      lat: s.lat,
      lng: s.lng,
      distanceMeters: s.d,
      distanceLabel: distanceLabel(s.d),
      routes: routes[i]!,
    }));
  } catch {
    return [];
  }
}
