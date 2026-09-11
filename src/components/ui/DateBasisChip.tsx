/** Region-browse style ⓘ tip chip — reused on market home date labels. */
export function DateBasisChip({
  label,
  help,
}: {
  label: string;
  help: string;
}) {
  return (
    <details className="region-basis-chip relative shrink-0">
      <summary className="inline-flex cursor-pointer items-center gap-0.5 whitespace-nowrap rounded-full border border-slate-200/90 bg-slate-50 px-2 py-[3px] text-[11px] font-medium leading-none text-slate-500 transition hover:border-slate-300 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400">
        {label}
        <span className="text-[10px] font-normal text-slate-400" aria-hidden="true">
          ⓘ
        </span>
      </summary>
      <p className="absolute left-0 top-[calc(100%+0.35rem)] z-20 w-72 max-w-[calc(100vw-2.5rem)] rounded-md border border-slate-200 bg-white px-2.5 py-2 text-pretty text-[12px] leading-5 text-slate-600 shadow-sm">
        {help}
      </p>
    </details>
  );
}
