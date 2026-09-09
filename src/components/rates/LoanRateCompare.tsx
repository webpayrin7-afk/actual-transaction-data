"use client";

import { LoanRatesPanel } from "@/components/rates/LoanRatesPanel";

export function LoanRateCompare() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 overflow-x-hidden px-4 py-6 sm:px-6">
      <p className="text-xs font-medium tracking-wide text-teal-700">도구</p>
      <LoanRatesPanel heading="h1" />
    </div>
  );
}
