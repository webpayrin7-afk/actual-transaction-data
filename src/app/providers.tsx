"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { GlobalLoadProgress, LoadProgressProvider } from "@/components/layout/LoadProgress";
import { InternalNavTracker } from "@/components/layout/InternalNavTracker";
import { NewVersionReload } from "@/components/layout/NewVersionReload";
import { ScrollToTopOnNavigate } from "@/components/layout/ScrollToTopOnNavigate";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <LoadProgressProvider>
        <Suspense fallback={null}>
          <InternalNavTracker />
          <ScrollToTopOnNavigate />
          <GlobalLoadProgress />
          <NewVersionReload />
        </Suspense>
        {children}
      </LoadProgressProvider>
    </QueryClientProvider>
  );
}
