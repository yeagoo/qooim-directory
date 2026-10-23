// Qoo.IM section in toolso's detail styling: the GitHub facts of a resource, laid out like the
// highlights table of toolso-ai-open src/features/tools/components/detail/hero.tsx and headed by its
// DetailHeading (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: new content (stars, forks,
// issues, language, license, last push) in place of the AI-written highlights Qoo.IM lacks.
import { ArrowUpRight } from "lucide-react";
import type { PublicProject } from "../../../../public/sdk.js";
import { useLocale, useTranslations } from "../../shims/next-intl.js";
import { formatDate } from "../catalog/resource.js";
import { sectionLinkClass } from "../section-header.js";
import { DetailHeading } from "./shared.js";

export function DetailGithub({ slug, index, project }: { slug: string; index?: number; project: PublicProject }) {
  const tq = useTranslations("qooim.catalog.github");
  const locale = useLocale();
  const number = (n: number) => new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en").format(n);
  const facts = [
    { label: tq("stars"), value: number(project.stars) },
    { label: tq("forks"), value: number(project.forks) },
    { label: tq("openIssues"), value: number(project.openIssues) },
    { label: tq("language"), value: project.language },
    { label: tq("license"), value: project.license },
    { label: tq("pushedAt"), value: formatDate(project.pushedAt, locale) },
  ].filter((fact) => fact.value);
  return (
    <section id={`section-${slug}`} className="detail-section">
      <DetailHeading
        index={index}
        action={
          <a
            href={`https://github.com/${project.fullName}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${sectionLinkClass} shrink-0 pb-1`}
          >
            {tq("viewRepo")}
            <ArrowUpRight className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </a>
        }
      >
        {tq("title")}
      </DetailHeading>
      <p className="num mb-5 truncate text-sm text-muted-foreground">
        {project.fullName}
        {project.archived && <span className="ml-2 rounded-md bg-secondary px-2 py-0.5 text-xs">{tq("archived")}</span>}
      </p>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <dl className="-mb-px -mr-px grid grid-cols-2 md:grid-cols-3">
          {facts.map((fact, i) => (
            <div key={fact.label} className="border-b border-r border-border p-4 sm:p-5">
              <div className="num text-xs text-primary">{String(i + 1).padStart(2, "0")}</div>
              <dt className="mt-3 text-sm leading-relaxed text-muted-foreground">{fact.label}</dt>
              <dd className="mt-1.5 text-[0.9375rem] font-semibold leading-snug tracking-tight text-foreground [overflow-wrap:anywhere]">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
