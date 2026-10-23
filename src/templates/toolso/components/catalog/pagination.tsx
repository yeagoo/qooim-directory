// Ported from toolso-ai-open src/app/[locale]/(marketing)/category/[slug]/page.tsx (pagination block) (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: extracted into a component shared by the catalog and category pages; links use Qoo.IM's ?page=N and keep q/category (toolso's /tools list used client-side /tools/page/N navigation instead).
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "../../shims/next-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { pagerNumActiveClass, pagerNumClass, pagerStepClass, pagerStepDisabledClass } from "./page-header.js";

export function Pagination({
  page,
  totalPages,
  href,
}: {
  page: number;
  totalPages: number;
  /** URL of page N (page 1 is the bare path). */
  href: (page: number) => string;
}) {
  const tc = useTranslations("tools.category");
  if (totalPages <= 1) return null;
  return (
    <nav
      className="mt-14 flex flex-wrap items-center justify-center gap-2"
      aria-label={tc("page", { page })}
    >
      {page > 1 ? (
        <Link href={href(page - 1)} className={pagerStepClass} rel="prev">
          <ChevronLeft className="h-4 w-4" />
          {tc("prev")}
        </Link>
      ) : (
        <span className={pagerStepDisabledClass}>
          <ChevronLeft className="h-4 w-4" />
          {tc("prev")}
        </span>
      )}

      {Array.from({ length: totalPages }, (_, i) => i + 1)
        .filter((p) => {
          if (totalPages <= 7) return true;
          if (p === 1 || p === totalPages) return true;
          if (Math.abs(p - page) <= 1) return true;
          return false;
        })
        .map((p, idx, arr) => {
          const prev = arr[idx - 1];
          const gap = prev && p - prev > 1;
          return (
            <span key={p} className="flex items-center">
              {gap && <span className="px-2 text-muted-foreground">…</span>}
              {p === page ? (
                <span aria-current="page" className={pagerNumActiveClass}>
                  {p}
                </span>
              ) : (
                <Link href={href(p)} className={pagerNumClass} aria-label={tc("page", { page: p })}>
                  {p}
                </Link>
              )}
            </span>
          );
        })}

      {page < totalPages ? (
        <Link href={href(page + 1)} className={pagerStepClass} rel="next">
          {tc("next")}
          <ChevronRight className="h-4 w-4" />
        </Link>
      ) : (
        <span className={pagerStepDisabledClass}>
          {tc("next")}
          <ChevronRight className="h-4 w-4" />
        </span>
      )}
    </nav>
  );
}

/** Catalog/category URL for page N, keeping the search and filter (Qoo.IM's server routes). */
export function pageHref(base: string, params: { q?: string; category?: string }, page: number) {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.category) query.set("category", params.category);
  if (page > 1) query.set("page", String(page));
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}
