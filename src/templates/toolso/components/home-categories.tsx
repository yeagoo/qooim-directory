// Ported from the "categories" section of toolso-ai-open src/app/[locale]/(marketing)/page.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: extracted into a component; takes Qoo.IM categories ({id,label,count}, id doubles as slug); the per-site category illustration (@/lib/sites/imagery) dropped, so the table always spans 12 columns; hrefs via LocaleLink/localePath; CategoryIcon via catalog/category-icon.
import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { PublicCategory } from "../../../public/sdk.js";
import { Container } from "./container.js";
import { SectionHeader, sectionLinkClass } from "./section-header.js";
import { LocaleLink } from "./locale-link.js";
import { CategoryIcon } from "./navigation/category-mark.js";
import { useTranslations } from "../shims/next-intl.js";

export function HomeCategories({
  categories,
  total,
  index,
}: {
  /** 有工具的分类,已排序;取前 12 */
  categories: PublicCategory[];
  /** 有工具的分类总数(版块标签用) */
  total: number;
  index?: string;
}) {
  const tt = useTranslations("tools");
  const tn = useTranslations("navigation.categoriesMenu");
  const topCategories = categories.slice(0, 12);
  if (topCategories.length === 0) return null;
  return (
    <section className="relative py-16 md:py-24">
      <Container>
        <SectionHeader
          index={index}
          eyebrow={tt("category.indexCount", { count: total })}
          title={tt("category.indexTitle")}
          action={
            <LocaleLink href="/category" className={sectionLinkClass}>
              {tn("viewAll")}
              <ArrowRight className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:translate-x-1" />
            </LocaleLink>
          }
        />
        <div className="mt-10 grid gap-4 lg:grid-cols-12">
          {/* 格线用单元格右/下边框画(而非 gap+底色):末行不满时不会露出灰色空格 */}
          <div className="overflow-hidden rounded-2xl border border-border bg-background lg:col-span-12">
          <ul className="-mb-px -mr-px grid h-full grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {topCategories.map((c) => (
              <li key={c.id} className="flex border-b border-r border-border">
                <LocaleLink
                  href={`/category/${c.id}`}
                  className="group relative flex min-h-[7.5rem] flex-1 flex-col justify-between p-4 transition-colors duration-300 hover:bg-card sm:p-5"
                >
                  <span className="flex items-center justify-between text-muted-foreground">
                    <span className="transition-colors duration-300 group-hover:text-primary">
                      <CategoryIcon slug={c.id} size={18} />
                    </span>
                    <span className="num text-xs">{c.count}</span>
                  </span>
                  <span className="mt-6 flex items-end justify-between gap-2">
                    <span className="text-[0.9375rem] font-medium leading-snug text-foreground sm:text-base">{c.label}</span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 -translate-x-1 translate-y-1 text-primary opacity-0 transition-all duration-300 ease-expo group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100" />
                  </span>
                  <span aria-hidden className="absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-primary transition-transform duration-500 ease-expo group-hover:scale-x-100" />
                </LocaleLink>
              </li>
            ))}
          </ul>
          </div>
        </div>
      </Container>
    </section>
  );
}
