// Qoo.IM (not ported): lists the published comparison pages that include this entry, in the
// look of the other detail sections (DetailHeading, card links).
import { ArrowRight } from "lucide-react";
import type { PublicComparison, PublicResource } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";
import { DetailHeading } from "./shared.js";

export function DetailComparisons({
  index,
  comparisons,
}: {
  index?: number;
  comparisons: (PublicComparison & { other: PublicResource })[];
}) {
  const tc = useTranslations("qooim.catalog.compare");
  return (
    <section id="section-comparisons" className="detail-section">
      <DetailHeading index={index}>{tc("title")}</DetailHeading>
      <ul className="grid gap-3 sm:grid-cols-2">
        {comparisons.map((c) => (
          <li key={c.id}>
            <Link
              href={localePath(`/compare/${c.id}`)}
              className="group flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-foreground/40"
            >
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{c.title}</span>
                <span className="block text-sm text-muted-foreground">{tc("versus", { name: c.other.title })}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
