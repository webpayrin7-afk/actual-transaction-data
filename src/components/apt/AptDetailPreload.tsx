"use client";

import { preload } from "react-dom";

/**
 * 시세·평형 API를 HTML에서 먼저 받게 하는 <link rel="preload" as="fetch"> — 첫 방문 문서 요청에서만 page.tsx가 그린다.
 * 서버 컴포넌트에서 부른 preload는 RSC 힌트(:HL)로만 실려 React가 뜬 뒤에야 적용되므로,
 * SSR이 <head>(또는 스트리밍 조각)에 <link>를 바로 쓰도록 클라이언트 컴포넌트 렌더 중에 부른다.
 * 주소는 fetch()와 바이트 단위로 같아야 브라우저가 응답을 다시 쓴다(apt-detail-url.ts 빌더).
 */
export function FetchPreload({ href }: { href: string }) {
  preload(href, { as: "fetch", crossOrigin: "anonymous" });
  return null;
}
