import React from "react";
import Link from "next/link";

type SampleNumber = 1 | 2 | 3;

const SAMPLES: readonly SampleNumber[] = [1, 2, 3];

const TONE_CLASSES = {
  light: {
    label: "text-[#6b796f]",
    link: "text-[#586f61] hover:text-[#245b4b] focus-visible:outline-[#245b4b]",
  },
  dark: {
    label: "text-[#8296a9]",
    link: "text-[#a9bac8] hover:text-[#efc69f] focus-visible:outline-[#efc69f]",
  },
};

export function SampleFooterNav({
  currentSample,
  tone,
}: {
  currentSample: SampleNumber;
  tone: "light" | "dark";
}) {
  const toneClasses = TONE_CLASSES[tone];

  return (
    <nav
      aria-label="Other sample pages"
      className="flex w-fit max-w-full flex-wrap items-center justify-end gap-x-1 self-end sm:ml-auto sm:self-auto"
    >
      <span className={`shrink-0 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${toneClasses.label}`}>
        Other samples
      </span>
      {SAMPLES.filter((sample) => sample !== currentSample).map((sample) => (
        <Link
          key={sample}
          href={`/sample${sample}`}
          className={`inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap rounded-md px-2 text-[11px] font-medium transition-colors hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${toneClasses.link}`}
        >
          Sample {sample}
        </Link>
      ))}
    </nav>
  );
}
