"use client";

import { MAP_VIEWBOX, HAN_RIVER_TILES, SEOUL_GU_LAYOUT } from "@/lib/leader-map/seoul-layout";
import type { GuLeaderRow, LeaderComplex } from "@/lib/leader-map/types";
import { formatEok } from "@/lib/utils/format";

type Tone = "gold" | "teal" | "rose" | "muted";

function toneFor(leader: LeaderComplex | null, selected: boolean): Tone {
  if (!leader) return "muted";
  if (selected) return "gold";
  if (leader.sampleQuality === "LOW") return "muted";
  if (leader.latestChange?.direction === "up") return "rose";
  return "teal";
}

function AptSprite({
  x,
  y,
  tone,
  lit,
  crowned,
}: {
  x: number;
  y: number;
  tone: Tone;
  lit: boolean;
  crowned: boolean;
}) {
  const fill =
    tone === "gold"
      ? "#f5c542"
      : tone === "rose"
        ? "#fb7185"
        : tone === "muted"
          ? "#7c8aa0"
          : "#2dd4bf";
  const body = tone === "gold" ? "#b45309" : "#0f3d48";
  const windowOn = lit ? "#fff7c2" : "#dbeafe";
  return (
    <g transform={`translate(${x - 6} ${y - 10})`} className="pixel-apt-sprite">
      {crowned ? (
        <path
          d="M1 3 L3 6 L6 2 L9 6 L11 3 L11 7 L1 7 Z"
          fill="#fbbf24"
          stroke="#78350f"
          strokeWidth="0.4"
        />
      ) : null}
      <rect x="2" y="7" width="8" height="9" fill={fill} />
      <rect x="1" y="7" width="10" height="2" fill={body} />
      <rect x="3" y="10" width="2" height="2" fill={windowOn} />
      <rect x="7" y="10" width="2" height="2" fill={windowOn} />
      <rect x="5" y="13" width="2" height="3" fill="#0f172a" />
    </g>
  );
}

export function PixelSeoulMap({
  gus,
  selectedSlug,
  onSelect,
}: {
  gus: GuLeaderRow[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const bySlug = new Map(gus.map((g) => [g.slug, g]));

  return (
    <svg
      className="pixel-seoul-map"
      viewBox={`0 0 ${MAP_VIEWBOX.w} ${MAP_VIEWBOX.h}`}
      role="img"
      aria-label="서울 25개 구 대장 아파트 픽셀 지도"
    >
      <rect width={MAP_VIEWBOX.w} height={MAP_VIEWBOX.h} fill="#071422" />
      {HAN_RIVER_TILES.map((tile, i) => (
        <rect
          key={`river-${i}`}
          className="pixel-han-river"
          x={tile.x}
          y={tile.y}
          width={tile.w}
          height={tile.h}
          fill="#38bdf8"
        />
      ))}
      {SEOUL_GU_LAYOUT.map((layout, index) => {
        const row = bySlug.get(layout.slug);
        const selected = selectedSlug === layout.slug;
        const leader = row?.leader ?? null;
        const tone = toneFor(leader, selected);
        const land = selected ? "#65a30d" : "#3f7a2a";
        const label = leader
          ? `${layout.name} 대장 아파트 ${leader.aptName}, 84제곱미터 환산 ${formatEok(leader.normalized84Price)}`
          : `${layout.name} 최근 거래 표본 부족`;
        return (
          <g
            key={layout.slug}
            className={`pixel-gu${selected ? " is-selected" : ""}`}
            style={{ animationDelay: `${index * 28}ms` }}
          >
            <title>{label}</title>
            {layout.tiles.map((tile, ti) => (
              <rect
                key={ti}
                x={tile.x}
                y={tile.y}
                width={tile.w}
                height={tile.h}
                fill={land}
                stroke={selected ? "#fbbf24" : "#0b1b14"}
                strokeWidth={selected ? 2 : 1}
              />
            ))}
            <AptSprite
              x={layout.marker.x}
              y={layout.marker.y}
              tone={tone}
              lit={selected}
              crowned={selected && Boolean(leader)}
            />
            <text
              x={layout.label.x}
              y={layout.label.y}
              textAnchor="middle"
              className={
                layout.prominent || selected
                  ? "pixel-gu-label is-on"
                  : "pixel-gu-label"
              }
              fill={selected ? "#fde68a" : "#dbe7d3"}
            >
              {layout.shortName}
            </text>
            <a
              href={`#gu-${layout.slug}`}
              onClick={(event) => {
                event.preventDefault();
                onSelect(layout.slug);
              }}
              aria-label={label}
              aria-current={selected ? "true" : undefined}
            >
              {layout.tiles.map((tile, ti) => (
                <rect
                  key={`hit-${ti}`}
                  x={tile.x}
                  y={tile.y}
                  width={tile.w}
                  height={tile.h}
                  fill="transparent"
                  className="pixel-gu-hit"
                />
              ))}
            </a>
          </g>
        );
      })}
    </svg>
  );
}
