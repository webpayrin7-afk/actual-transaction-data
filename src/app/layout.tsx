import type { Metadata } from "next";
import { Outfit, Noto_Sans_KR } from "next/font/google";
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
  title: "안양시 아파트 실거래가 | 만안구·동안구",
  description:
    "안양시 만안구·동안구 아파트 매매·전월세 실거래가 및 일별 동향 대시보드",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${outfit.variable} ${notoSansKr.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
