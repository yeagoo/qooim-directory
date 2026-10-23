// Ported from toolso-ai-open src/features/tools/components/detail/pros-cons.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the two cards are the listing's pros and cons (plain-text items) instead of parsed use cases and limitations with name/description pairs.
import { AlertCircle, Check } from "lucide-react";
import { DetailHeading } from "./shared.js";

/** 「优点 & 不足」:两张并排卡,任一侧为空则只渲染另一侧。 */
export function DetailProsCons({
  index,
  title,
  prosTitle,
  consTitle,
  pros,
  cons,
}: {
  index?: number;
  title: string;
  prosTitle: string;
  consTitle: string;
  pros: string[];
  cons: string[];
}) {
  return (
    <section id="section-pros-cons" className="detail-section">
      <DetailHeading index={index}>{title}</DetailHeading>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {pros.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="mb-5 flex items-center gap-2.5 text-[0.9375rem] font-semibold text-foreground">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"><Check className="h-3.5 w-3.5" /></span>
              {prosTitle}
            </div>
            <ul className="space-y-3.5 text-[0.9375rem] leading-relaxed">
              {pros.map((item, i) => (
                <li key={i} className="flex gap-3">
                  <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                  <span className="text-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {cons.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="mb-5 flex items-center gap-2.5 text-[0.9375rem] font-semibold text-foreground">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"><AlertCircle className="h-3.5 w-3.5" /></span>
              {consTitle}
            </div>
            <ul className="space-y-3.5 text-[0.9375rem] leading-relaxed">
              {cons.map((item, i) => (
                <li key={i} className="flex gap-3">
                  <AlertCircle className="mt-1 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                  <span className="text-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
