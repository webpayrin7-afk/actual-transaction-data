"use client";

import { useId, useState, type ReactNode } from "react";

export type FaqItem = {
  question: string;
  answer: ReactNode;
};

function FaqRow({ item }: { item: FaqItem }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonId = useId();

  return (
    <div className="border-b border-slate-200 last:border-b-0">
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start justify-between gap-3 py-3.5 text-left text-sm font-medium text-slate-900 transition hover:text-teal-800 sm:text-[0.9375rem]"
        >
          <span className="min-w-0">{item.question}</span>
          <span
            aria-hidden
            className={`mt-0.5 shrink-0 text-slate-400 transition ${open ? "rotate-45" : ""}`}
          >
            +
          </span>
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        className="pb-3.5 text-sm leading-7 text-slate-600 sm:text-[0.9375rem]"
      >
        {item.answer}
      </div>
    </div>
  );
}

export function FaqAccordion({ items }: { items: FaqItem[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 sm:px-5">
      {items.map((item) => (
        <FaqRow key={item.question} item={item} />
      ))}
    </div>
  );
}
