import type { Metadata } from "next";
import { Outfit, Noto_Sans_KR } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell";
import { Providers } from "./providers";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const notoSansKr = Noto_Sans_KR({
  variable: "--font-pretendard",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "집랩 | 오늘의 아파트 시장",
  description:
    "서울·경기 아파트 실거래·신고가·하락거래·거래량 변화를 한눈에 보는 집랩",
  openGraph: {
    title: "집랩",
    description: "오늘의 아파트 시장 · 실거래·신고가·지역별 조회",
    images: [
      {
        url: "/og-thumbnail.png",
        width: 1536,
        height: 1024,
        alt: "집랩 아파트 시장 썸네일",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "집랩",
    description: "오늘의 아파트 시장 · 실거래·신고가·지역별 조회",
    images: ["/og-thumbnail.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${outfit.variable} ${notoSansKr.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
