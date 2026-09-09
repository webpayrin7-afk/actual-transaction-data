import { SEOUL_REGIONS } from "@/lib/constants/regions";

export type PixelRect = { x: number; y: number; w: number; h: number };

export type GuMapLayout = {
  slug: string;
  lawdCd: string;
  name: string;
  shortName: string;
  tiles: PixelRect[];
  marker: { x: number; y: number };
  label: { x: number; y: number };
  /** 모바일에서도 구 이름 상시 표시 */
  prominent: boolean;
};

/** viewBox 단위. 8px 타일 그리드. */
export const MAP_VIEWBOX = { w: 360, h: 272 } as const;

export const HAN_RIVER_TILES: PixelRect[] = [
  { x: 16, y: 128, w: 40, h: 14 },
  { x: 52, y: 132, w: 44, h: 14 },
  { x: 92, y: 128, w: 48, h: 16 },
  { x: 136, y: 124, w: 52, h: 16 },
  { x: 184, y: 128, w: 48, h: 14 },
  { x: 228, y: 132, w: 52, h: 14 },
  { x: 276, y: 128, w: 68, h: 16 },
];

const BY_SLUG = Object.fromEntries(SEOUL_REGIONS.map((r) => [r.slug, r]));

function gu(
  slug: string,
  layout: Omit<GuMapLayout, "slug" | "lawdCd" | "name">,
): GuMapLayout {
  const region = BY_SLUG[slug];
  if (!region) throw new Error(`unknown seoul slug ${slug}`);
  return {
    slug,
    lawdCd: region.lawdCodes[0]!,
    name: region.name,
    ...layout,
  };
}

/**
 * 행정경계 GIS가 아니라 서울을 알아볼 수 있는 픽셀 배치.
 * 한강이 동서 방향감을 잡는다.
 */
export const SEOUL_GU_LAYOUT: GuMapLayout[] = [
  gu("seoul-dobong", {
    shortName: "도봉",
    tiles: [{ x: 176, y: 12, w: 36, h: 28 }],
    marker: { x: 194, y: 22 },
    label: { x: 194, y: 8 },
    prominent: false,
  }),
  gu("seoul-nowon", {
    shortName: "노원",
    tiles: [{ x: 220, y: 12, w: 48, h: 32 }],
    marker: { x: 244, y: 24 },
    label: { x: 244, y: 8 },
    prominent: true,
  }),
  gu("seoul-gangbuk", {
    shortName: "강북",
    tiles: [{ x: 156, y: 40, w: 36, h: 28 }],
    marker: { x: 174, y: 50 },
    label: { x: 174, y: 36 },
    prominent: false,
  }),
  gu("seoul-seongbuk", {
    shortName: "성북",
    tiles: [{ x: 196, y: 44, w: 36, h: 28 }],
    marker: { x: 214, y: 54 },
    label: { x: 214, y: 40 },
    prominent: false,
  }),
  gu("seoul-jungnang", {
    shortName: "중랑",
    tiles: [{ x: 240, y: 44, w: 40, h: 32 }],
    marker: { x: 260, y: 56 },
    label: { x: 260, y: 40 },
    prominent: false,
  }),
  gu("seoul-eunpyeong", {
    shortName: "은평",
    tiles: [{ x: 92, y: 48, w: 48, h: 32 }],
    marker: { x: 116, y: 60 },
    label: { x: 116, y: 44 },
    prominent: false,
  }),
  gu("seoul-jongno", {
    shortName: "종로",
    tiles: [{ x: 156, y: 68, w: 40, h: 24 }],
    marker: { x: 176, y: 76 },
    label: { x: 176, y: 64 },
    prominent: false,
  }),
  gu("seoul-dongdaemun", {
    shortName: "동대문",
    tiles: [{ x: 208, y: 72, w: 36, h: 24 }],
    marker: { x: 226, y: 80 },
    label: { x: 226, y: 68 },
    prominent: false,
  }),
  gu("seoul-seodaemun", {
    shortName: "서대문",
    tiles: [{ x: 108, y: 80, w: 40, h: 24 }],
    marker: { x: 128, y: 88 },
    label: { x: 128, y: 76 },
    prominent: false,
  }),
  gu("seoul-jung", {
    shortName: "중구",
    tiles: [{ x: 160, y: 92, w: 32, h: 22 }],
    marker: { x: 176, y: 100 },
    label: { x: 176, y: 88 },
    prominent: false,
  }),
  gu("seoul-seongdong", {
    shortName: "성동",
    tiles: [{ x: 204, y: 96, w: 36, h: 26 }],
    marker: { x: 222, y: 106 },
    label: { x: 222, y: 92 },
    prominent: false,
  }),
  gu("seoul-gwangjin", {
    shortName: "광진",
    tiles: [{ x: 248, y: 96, w: 36, h: 30 }],
    marker: { x: 266, y: 108 },
    label: { x: 266, y: 92 },
    prominent: false,
  }),
  gu("seoul-mapo", {
    shortName: "마포",
    tiles: [{ x: 100, y: 104, w: 48, h: 24 }],
    marker: { x: 124, y: 112 },
    label: { x: 124, y: 100 },
    prominent: true,
  }),
  gu("seoul-yongsan", {
    shortName: "용산",
    tiles: [{ x: 152, y: 144, w: 44, h: 24 }],
    marker: { x: 174, y: 152 },
    label: { x: 174, y: 140 },
    prominent: true,
  }),
  gu("seoul-gangseo", {
    shortName: "강서",
    tiles: [{ x: 16, y: 88, w: 64, h: 40 }],
    marker: { x: 48, y: 104 },
    label: { x: 48, y: 84 },
    prominent: false,
  }),
  gu("seoul-yangcheon", {
    shortName: "양천",
    tiles: [{ x: 48, y: 152, w: 40, h: 24 }],
    marker: { x: 68, y: 160 },
    label: { x: 68, y: 148 },
    prominent: false,
  }),
  gu("seoul-yeongdeungpo", {
    shortName: "영등포",
    tiles: [{ x: 92, y: 148, w: 44, h: 24 }],
    marker: { x: 114, y: 156 },
    label: { x: 114, y: 144 },
    prominent: false,
  }),
  gu("seoul-dongjak", {
    shortName: "동작",
    tiles: [{ x: 140, y: 168, w: 36, h: 24 }],
    marker: { x: 158, y: 176 },
    label: { x: 158, y: 164 },
    prominent: false,
  }),
  gu("seoul-seocho", {
    shortName: "서초",
    tiles: [{ x: 184, y: 160, w: 40, h: 32 }],
    marker: { x: 204, y: 172 },
    label: { x: 204, y: 156 },
    prominent: true,
  }),
  gu("seoul-gangnam", {
    shortName: "강남",
    tiles: [{ x: 228, y: 156, w: 44, h: 36 }],
    marker: { x: 250, y: 170 },
    label: { x: 250, y: 152 },
    prominent: true,
  }),
  gu("seoul-songpa", {
    shortName: "송파",
    tiles: [{ x: 276, y: 148, w: 40, h: 36 }],
    marker: { x: 296, y: 162 },
    label: { x: 296, y: 144 },
    prominent: true,
  }),
  gu("seoul-gangdong", {
    shortName: "강동",
    tiles: [{ x: 316, y: 120, w: 32, h: 36 }],
    marker: { x: 332, y: 134 },
    label: { x: 332, y: 116 },
    prominent: false,
  }),
  gu("seoul-guro", {
    shortName: "구로",
    tiles: [{ x: 48, y: 180, w: 40, h: 24 }],
    marker: { x: 68, y: 188 },
    label: { x: 68, y: 176 },
    prominent: false,
  }),
  gu("seoul-geumcheon", {
    shortName: "금천",
    tiles: [{ x: 92, y: 188, w: 32, h: 24 }],
    marker: { x: 108, y: 196 },
    label: { x: 108, y: 184 },
    prominent: false,
  }),
  gu("seoul-gwanak", {
    shortName: "관악",
    tiles: [{ x: 132, y: 196, w: 44, h: 28 }],
    marker: { x: 154, y: 206 },
    label: { x: 154, y: 192 },
    prominent: false,
  }),
];

export const SEOUL_LAYOUT_BY_LAWD: Record<string, GuMapLayout> = Object.fromEntries(
  SEOUL_GU_LAYOUT.map((g) => [g.lawdCd, g]),
);

export const SEOUL_LAYOUT_BY_SLUG: Record<string, GuMapLayout> = Object.fromEntries(
  SEOUL_GU_LAYOUT.map((g) => [g.slug, g]),
);
