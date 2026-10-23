// Ported from toolso-ai-open src/app/[locale]/(marketing)/compare/[slug]/page.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: fed by a reviewed Qoo.IM comparison (title + Markdown body written or AI-drafted by editors and published) instead of on-demand AI content; the H1 is the comparison title; the two ToolCards keep toolso's layout (logo or plain tile, linked name, pricing, pros, visit link) and add the tagline, while "when to choose" (no such field) is covered by the Markdown body; a key-facts table (pricing, categories, features, pros, cons) sits between the cards and the body; breadcrumb, Background and page shell from the catalog pages; the Article JSON-LD is built in lib/seo.ts; external links use rel="noopener noreferrer nofollow".
import type { ReactNode } from "react";
import type { PublicComparison, PublicResource } from "../../../../public/sdk.js";
import Image from "../../shims/next-image.js";
import Link from "../../shims/next-link.js";
import { useLocale, useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";
import { Background } from "../background.js";
import { PageHeader, pageShellClass } from "../catalog/page-header.js";
import { pricingBadge, pricingLabel } from "../catalog/pricing.js";
import { externalUrl } from "../catalog/resource.js";
import { DetailMarkdown, PROSE } from "../detail/shared.js";

export function CompareView({
  comparison,
  tools,
}: {
  comparison: PublicComparison;
  tools: PublicResource[];
}) {
  const t = useTranslations();
  const tc = useTranslations("qooim.catalog.compare");
  const td = useTranslations("tools.detail");
  const locale = useLocale();
  const date = comparison.updated_at
    ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(comparison.updated_at),
      )
    : null;
  const price = (tool: PublicResource) => {
    const badge = pricingBadge(tool.details?.pricing);
    return badge ? pricingLabel(badge, t) : "—";
  };
  const list = (values: string[] | undefined) =>
    values && values.length ? (
      <ul className="list-disc space-y-1 pl-5">
        {values.map((v, i) => (
          <li key={i}>{v}</li>
        ))}
      </ul>
    ) : (
      "—"
    );
  const rows: [string, (tool: PublicResource) => ReactNode][] = [
    [tc("pricing"), price],
    [tc("categories"), (tool) => (tool.categories ?? []).map((c) => c.label).join(" / ") || "—"],
    [tc("features"), (tool) => list(tool.details?.features)],
    [tc("pros"), (tool) => list(tool.details?.pros)],
    [tc("cons"), (tool) => list(tool.details?.cons)],
  ];
  return (
    <div className="relative">
      <Background />
      <div className={pageShellClass}>
        <PageHeader
          crumbs={[
            { name: td("home"), href: localePath("/") },
            { name: t("tools.title"), href: localePath("/tools") },
            { name: comparison.title },
          ]}
          title={comparison.title}
          meta={date ? tc("updated", { date }) : undefined}
        />
        <div className="grid gap-6 md:grid-cols-2">
          {tools.map((tool, i) => (
            <ToolCard key={tool.resource_id} tool={tool} accent={i === 0 ? "left" : "right"} />
          ))}
        </div>
        <section id="section-facts" className="mt-12 overflow-x-auto">
          <h2 className="mb-4 text-xl font-semibold text-foreground">{tc("facts")}</h2>
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="py-3 pr-4" />
                {tools.map((tool) => (
                  <th key={tool.resource_id} scope="col" className="py-3 pr-4 font-semibold text-foreground">
                    {tool.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, cell]) => (
                <tr key={label} className="border-b border-border/60 align-top">
                  <th scope="row" className="py-3 pr-4 font-medium text-muted-foreground">
                    {label}
                  </th>
                  {tools.map((tool) => (
                    <td key={tool.resource_id} className="py-3 pr-4 text-foreground">
                      {cell(tool)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {comparison.content && (
          <article className={`mt-12 ${PROSE}`}>
            <DetailMarkdown>{comparison.content}</DetailMarkdown>
          </article>
        )}
      </div>
    </div>
  );
}

function ToolCard({ tool, accent }: { tool: PublicResource; accent: "left" | "right" }) {
  const t = useTranslations();
  const tc = useTranslations("qooim.catalog.compare");
  const badge = pricingBadge(tool.details?.pricing);
  const website = externalUrl(tool.url);
  const pros = tool.details?.pros ?? [];
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-3">
        {tool.logo ? (
          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded">
            <Image src={tool.logo.url} alt={tool.logo.alt || tool.title} fill className="object-cover" />
          </div>
        ) : (
          <div className={`h-10 w-10 shrink-0 rounded ${accent === "left" ? "bg-blue-100" : "bg-emerald-100"}`} />
        )}
        <div>
          <Link href={localePath(`/tools/${tool.slug}`)} className="text-lg font-semibold hover:underline">
            {tool.title}
          </Link>
          {badge ? <div className="text-xs text-muted-foreground">{pricingLabel(badge, t)}</div> : null}
        </div>
      </div>
      {(tool.details?.tagline || tool.description) && (
        <p className="mb-4 text-sm text-muted-foreground">{tool.details?.tagline || tool.description}</p>
      )}
      {pros.length > 0 && (
        <>
          <h3 className="mb-2 text-sm font-semibold">{tc("pros")}</h3>
          <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
            {pros.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-4 flex items-center gap-4 text-xs">
        <Link href={localePath(`/tools/${tool.slug}`)} className="text-primary hover:underline">
          {tc("details")} →
        </Link>
        {website ? (
          <a href={website} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-600 hover:underline">
            {t("tools.visitWebsite")} →
          </a>
        ) : null}
      </div>
    </div>
  );
}
