// Ported from toolso-ai-open src/app/[locale]/not-found.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: synchronous, uses the request locale; the per-site illustration is gone, so the heading is errors.404.message; adds links to the page's other-language versions (page.alternates); links via localePath.
import type { TemplatePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { missingSeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";
import { ArrowUpRight } from "lucide-react";
import Link from "../shims/next-link.js";
import { useTranslations } from "../shims/next-intl.js";
import { useSite } from "../shims/site.js";
import { localePath } from "../runtime.js";

type Page = Extract<TemplatePage, { kind: "missing" }>;
export function MissingPage({ page }: { page: Page }) {
  return (
    <Document page={page} seo={missingSeo(page)}>
      <SiteChrome>
        <main>
          <LocaleNotFound page={page} />
        </main>
      </SiteChrome>
    </Document>
  );
}

/** 按域 404:巨型数字 + 本地化说明 + 回家链接;有其他语言版本时一并列出。 */
function LocaleNotFound({ page }: { page: Page }) {
  const site = useSite();
  const te = useTranslations("errors.404");
  const tq = useTranslations("qooim.catalog");
  const others = page.alternates.filter((a) => a.locale !== page.locale);
  return (
    <div className="relative overflow-hidden">
      <div aria-hidden className="hairline-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_30%,#000_20%,transparent_75%)]" />
      <div className="relative mx-auto grid min-h-[100dvh] w-full max-w-7xl items-center gap-12 px-5 py-28 sm:px-8 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <p className="eyebrow flex items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {site.brandName}
          </p>
          {/* 巨型数字是视觉主体;真正的语义标题是下面那句本地化文案 */}
          <p aria-hidden className="num mt-6 text-[clamp(6rem,22vw,15rem)] font-medium leading-[0.85] tracking-[-0.06em] text-foreground">
            4<span className="text-primary">0</span>4
          </p>
          <h1 className="mt-8 max-w-[40ch] text-xl leading-relaxed text-muted-foreground first-letter:uppercase md:text-2xl">
            {te("message")}
          </h1>
          {others.length > 0 && (
            <div className="mt-8">
              <p className="eyebrow mb-3">{tq("otherLanguages")}</p>
              <ul className="flex flex-wrap gap-2">
                {others.map((a) => (
                  <li key={a.locale}>
                    <a
                      href={a.url}
                      hrefLang={a.locale}
                      lang={a.locale}
                      className="group inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-sm text-foreground transition-colors duration-200 hover:border-foreground/40 hover:bg-hover active:scale-[0.97]"
                    >
                      {tq(`localeNames.${a.locale}`)}
                      <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link
            href={localePath("/")}
            className="group mt-10 inline-flex h-[3.25rem] items-center gap-3 rounded-full bg-foreground px-7 text-base font-medium text-background transition-transform duration-300 ease-expo hover:-translate-y-px active:scale-[0.97]"
          >
            <span aria-hidden className="transition-transform duration-300 ease-expo group-hover:-translate-x-1">←</span>
            {site.brandName}
          </Link>
        </div>
      </div>
    </div>
  );
}
