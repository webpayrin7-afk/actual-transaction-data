import type { Metadata } from "next";
import { Outfit, Noto_Sans_KR } from "next/font/google";
import { SiteHeader } from "@/components/layout/SiteHeader";
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
  title: "아파트 실거래 | 서울·경기 아파트 실거래가",
  description:
    "서울 25개 구, 경기 31개 시·군 아파트 매매·전월세 실거래가 TOP 및 지역별 조회",
  openGraph: {
    title: "아파트 실거래",
    description: "서울·경기 아파트 매매·전월세 실거래가와 일별 신고가",
    images: [
      {
        url: "/og-thumbnail.png",
        width: 1536,
        height: 1024,
        alt: "아파트 실거래 썸네일",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "아파트 실거래",
    description: "서울·경기 아파트 매매·전월세 실거래가와 일별 신고가",
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
          <SiteHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
