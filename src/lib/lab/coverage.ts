import { REGION_DETAIL } from "@/lib/constants/regions";

/**
 * 실험실 coverage 표기.
 * 전국 확대 시 이 레이블(또는 REGION_DETAIL)만 갱신하면 된다.
 * 코드에 "서울/경기"를 깊게 hard-code하지 말 것.
 */
export function labCoverageLabel(): string {
  return `현재 제공 지역(${REGION_DETAIL})`;
}

export function labCoverageShort(): string {
  return REGION_DETAIL;
}
