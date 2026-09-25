"use client";

/**
 * Enter transition for /apt/[name] full-page detail.
 * CSS-only slide-in; remounts with the page so navigation replays the animation.
 */
export function AptDetailEnterTransition({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="apt-detail-enter min-w-0 overflow-x-clip">{children}</div>
  );
}
