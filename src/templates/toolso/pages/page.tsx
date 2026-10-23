// Ported from toolso-ai-open src/app/[locale]/(marketing)/privacy/page.tsx (Apache-2.0,
// Copyright 2025 CoolChange.AI). Changes: content comes from site config Markdown; one
// synchronous route serves about/privacy/terms/contact; chrome and sanitized Markdown come
// from Qoo.IM's toolso template, with localized page labels and page-DTO-only SEO.
import type { TemplateStaticPage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { staticSeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";
import { DetailMarkdown, PROSE } from "../components/detail/shared.js";
import { useTranslations } from "../shims/next-intl.js";

export function StaticPage({ page }: { page: TemplateStaticPage }) {
  return (
    <Document page={page} seo={staticSeo(page)}>
      <StaticPageBody page={page} />
    </Document>
  );
}

function StaticPageBody({ page }: { page: TemplateStaticPage }) {
  const t = useTranslations("qooim.catalog.page");
  return (
      <SiteChrome>
        <main className="mx-auto w-full max-w-4xl px-5 pb-20 pt-32 sm:px-8 md:pt-36">
          <article>
            <p className="eyebrow">{t(page.key)}</p>
            <h1 className="mt-4 text-[clamp(2rem,6vw,3.5rem)] font-semibold leading-tight tracking-[-0.04em] text-foreground">
              {page.title}
            </h1>
            <div className={`${PROSE} mt-10`}>
              <DetailMarkdown>{page.content}</DetailMarkdown>
            </div>
          </article>
        </main>
      </SiteChrome>
  );
}
