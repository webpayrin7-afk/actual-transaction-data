/**
 * Nearby APT + residential officetel supply by 시군구.
 * Server-only. Applyhome OpenAPI. Daily fetch cache. No DB writes.
 * Scope: REGION_SUPPLY / SIGUNGU_SCOPE.
 */

import {
  SUPPLY_EMPTY_MESSAGE,
  SUPPLY_NO_REGION_MESSAGE,
  SUPPLY_UNAVAILABLE_MESSAGE,
  buildSupplyFeed,
  kstToday,
  pickCompetition,
  type ApplyhomeCompetitionRow,
  type ApplyhomeDetailRow,
  type NearbySaleCard,
  type NearbySalesResult,
  type NearbySourceType,
} from "@/lib/complex-detail/nearby-supply";

const ENDPOINTS = {
  "apt-detail":
    "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail",
  "officetel-detail":
    "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getUrbtyOfctlLttotPblancDetail",
  "apt-competition":
    "https://api.odcloud.kr/api/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet",
} as const;

export type SupplyEndpoint = keyof typeof ENDPOINTS;

const DAILY_REVALIDATE = 86_400;

type OdcloudPage<T> = {
  currentCount?: number;
  matchCount?: number;
  totalCount?: number;
  data?: T[];
};

export type SupplyListFetcher = (
  endpoint: SupplyEndpoint,
  params: Record<string, string>,
) => Promise<Record<string, unknown>[]>;

function serviceKey(): string | null {
  const raw = process.env.MOLIT_API_KEY?.trim();
  if (!raw) return null;
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}

function safeLog(scope: string, err: unknown) {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  console.error(
    scope,
    msg.replace(/serviceKey=[^&\s]+/gi, "serviceKey=(redacted)"),
  );
}

async function odcloudGet<T>(
  endpoint: SupplyEndpoint,
  params: Record<string, string>,
): Promise<T[]> {
  const key = serviceKey();
  if (!key) throw new Error("missing server credential");

  const all: T[] = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const qs = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      returnType: "JSON",
      ...params,
    });
    const url = `${ENDPOINTS[endpoint]}?serviceKey=${key}&${qs.toString()}`;
    const res = await fetch(url, {
      next: { revalidate: DAILY_REVALIDATE },
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Applyhome HTTP ${res.status}`);
    const body = (await res.json()) as OdcloudPage<T>;
    const chunk = body.data ?? [];
    all.push(...chunk);
    const match = body.matchCount;
    if (chunk.length < perPage) break;
    if (typeof match === "number" && all.length >= match) break;
    if (page >= 20) break;
    page += 1;
  }
  return all;
}

function unavailable(sigungu: string | null, message: string): NearbySalesResult {
  return {
    status: "UNAVAILABLE",
    message,
    sigungu,
    scope: "SIGUNGU",
    items: [],
  };
}

async function loadDetails(
  endpoint: "apt-detail" | "officetel-detail",
  sigungu: string,
  fetcher: SupplyListFetcher,
): Promise<{ ok: boolean; rows: ApplyhomeDetailRow[] }> {
  try {
    const rows = (await fetcher(endpoint, {
      "cond[HSSPLY_ADRES::LIKE]": sigungu,
    })) as ApplyhomeDetailRow[];
    return { ok: true, rows };
  } catch (err) {
    safeLog(`[nearby-sales:${endpoint}]`, err);
    return { ok: false, rows: [] };
  }
}

async function attachCompetition(
  cards: NearbySaleCard[],
  fetcher: SupplyListFetcher,
): Promise<NearbySaleCard[]> {
  return Promise.all(
    cards.map(async (card) => {
      if (card.sourceType !== "APT" || card.currentStatus === "move_in_upcoming") {
        return card;
      }
      try {
        const rows = (await fetcher("apt-competition", {
          "cond[HOUSE_MANAGE_NO::EQ]": card.houseManageNo,
          "cond[PBLANC_NO::EQ]": card.pblancNo,
        })) as ApplyhomeCompetitionRow[];
        return { ...card, competition: pickCompetition(rows) };
      } catch (err) {
        safeLog("[nearby-sales:competition]", err);
        return card;
      }
    }),
  );
}

export async function fetchNearbySalesBySigungu(
  sigunguRaw: string,
  options?: { today?: Date; fetcher?: SupplyListFetcher },
): Promise<NearbySalesResult> {
  const sigungu = sigunguRaw.trim();
  if (!sigungu) return unavailable(null, SUPPLY_NO_REGION_MESSAGE);
  if (!options?.fetcher && !serviceKey()) {
    safeLog("[nearby-sales]", "missing server credential");
    return unavailable(sigungu, SUPPLY_UNAVAILABLE_MESSAGE);
  }

  const fetcher = options?.fetcher ?? odcloudGet;
  const today = options?.today ?? kstToday();

  try {
    const [apt, officetel] = await Promise.all([
      loadDetails("apt-detail", sigungu, fetcher),
      loadDetails("officetel-detail", sigungu, fetcher),
    ]);

    if (!apt.ok && !officetel.ok) {
      return unavailable(sigungu, SUPPLY_UNAVAILABLE_MESSAGE);
    }

    const tagged: Array<{ row: ApplyhomeDetailRow; sourceType: NearbySourceType }> = [
      ...apt.rows.map((row) => ({ row, sourceType: "APT" as const })),
      ...officetel.rows.map((row) => ({
        row,
        sourceType: "OFFICETEL" as const,
      })),
    ];
    const feed = buildSupplyFeed(tagged, sigungu, today);
    if (feed.length === 0 && (!apt.ok || !officetel.ok)) {
      return unavailable(sigungu, SUPPLY_UNAVAILABLE_MESSAGE);
    }

    const items = await attachCompetition(feed, fetcher);
    if (items.length === 0) {
      return {
        status: "EMPTY",
        message: SUPPLY_EMPTY_MESSAGE,
        sigungu,
        scope: "SIGUNGU",
        items: [],
      };
    }
    return {
      status: "AVAILABLE",
      message: "",
      sigungu,
      scope: "SIGUNGU",
      items,
    };
  } catch (err) {
    safeLog("[nearby-sales]", err);
    return unavailable(sigungu, SUPPLY_UNAVAILABLE_MESSAGE);
  }
}
