// Ported from toolso-ai-open src/components/badge-embed.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: static server markup with no React state or Next image; one entry badge in light and dark variants, copied through Qoo.IM's data-copy hook; the snippet links to the canonical detail page and uses the hosted SVG badge.
import { Copy } from "lucide-react";
import type { TemplatePage } from "../../../../public/sdk.js";
import { escapeHtml } from "../../../../public/sdk.js";
import { useTranslations } from "../../shims/next-intl.js";
import { DetailHeading } from "./shared.js";

type Page = Extract<TemplatePage, { kind: "detail" }>;

function BadgeCard({
  page,
  theme,
}: {
  page: Page;
  theme: "light" | "dark";
}) {
  const t = useTranslations("qooim.catalog.badge");
  const locale = page.locale === "en" ? "en" : "zh";
  const alt = `${t(theme === "light" ? "lightAlt" : "darkAlt")} · ${page.item.title}`;
  const path = `/badge/${locale}/${page.item.slug}.svg${theme === "dark" ? "?theme=dark" : ""}`;
  const snippet = `<a href="${escapeHtml(page.canonical)}"><img src="${escapeHtml(page.origin + path)}" alt="${escapeHtml(alt)}" width="256" height="64"></a>`;
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {t(theme === "light" ? "light" : "dark")}
      </div>
      <div className={`flex items-center justify-center rounded-xl border p-5 ${theme === "dark" ? "border-zinc-700 bg-zinc-900" : "border-zinc-200 bg-zinc-50"}`}>
        <img src={path} alt={alt} width={256} height={64} />
      </div>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-muted/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <code>{snippet}</code>
      </pre>
      <button
        type="button"
        data-copy={snippet}
        data-copied-label={t("copied")}
        data-failed-label={t("copyFailed")}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-hover"
      >
        <Copy className="h-4 w-4" />
        {t(theme === "light" ? "copyLight" : "copyDark")}
      </button>
    </div>
  );
}

export function DetailBadge({ page, index }: { page: Page; index?: number }) {
  const t = useTranslations("qooim.catalog.badge");
  return (
    <section id="section-badge" className="detail-section">
      <DetailHeading index={index}>{t("title")}</DetailHeading>
      <p className="mb-6 max-w-[65ch] text-sm leading-relaxed text-muted-foreground">{t("description")}</p>
      <div className="grid gap-5 sm:grid-cols-2">
        <BadgeCard page={page} theme="light" />
        <BadgeCard page={page} theme="dark" />
      </div>
    </section>
  );
}
