/**
 * 3D 바닥 한 변(m) — NAVER Static Map level 15, scale=2 이미지는 한 변이 월드 px 512 (웹 메르카토르 m/px × 512 ≈ 1.9km).
 * 바닥 지도·지형 격자가 같은 크기로 겹치도록 서버·화면이 함께 쓴다.
 */
export function groundSizeM(lat: number): number {
  const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** 15);
  return 512 * mpp;
}

/** 지형 격자 응답 — heights는 base64 Int16 (단지 중심 높이 기준 상대값, 0.1m 단위), 북쪽 행부터·서쪽 열부터 */
export type TerrainGridPayload = {
  source: string;
  sourceLabel: string;
  /** 원천 해상도 (m, 대략) */
  resolutionM: number;
  sizeM: number;
  n: number;
  /** 단지 중심 해발고도 (m) */
  originElevationM: number;
  minM: number;
  maxM: number;
  heights: string;
};
