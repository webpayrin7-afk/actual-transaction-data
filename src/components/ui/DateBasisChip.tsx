"use client";

import { InfoChip } from "@/components/ui/InfoChip";

/** Region-browse style ⓘ tip chip — reused on market home date labels. */
export function DateBasisChip({
  label,
  help,
}: {
  label: string;
  help: string;
}) {
  return <InfoChip label={label}>{help}</InfoChip>;
}
