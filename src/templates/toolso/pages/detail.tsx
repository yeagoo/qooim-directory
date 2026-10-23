// Ported from toolso-ai-open src/app/[locale]/(marketing)/tools/[slug]/page.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: synchronous, fed by Qoo.IM page data; head data (title, OG, JSON-LD) comes from lib/seo.ts; the long-form sections come from the listing's rich fields (overview = Markdown content, key features, use cases, pros/cons, FAQ) instead of parsed content, how-to/tips/audience/platforms/pricing prose is dropped (no data), and the entry's alternatives page is linked from the related block and sidebar; cordis plugin blocks, view counter and adjacent-tool links dropped; a GitHub repository section follows the pros/cons when the resource has a project; a Qoo.IM comparisons section (published A-vs-B pages with this entry) follows the FAQ; the contents list covers every rendered section; the category sidebar uses the page's categories.
import type { TemplatePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { detailSeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";
import { ArrowLeft } from "lucide-react";
import Link from "../shims/next-link.js";
import { useTranslations } from "../shims/next-intl.js";
import { localePath } from "../runtime.js";
import { Background } from "../components/background.js";
import { CategorySidebar } from "../components/catalog/category-sidebar.js";
import { DetailBreadcrumb } from "../components/detail/breadcrumb.js";
import { DetailFaq } from "../components/detail/faq.js";
import { DetailProseSection } from "../components/detail/prose-section.js";
import { DetailProsCons } from "../components/detail/pros-cons.js";
import { DetailComparisons } from "../components/detail/comparisons.js";
import { DetailGithub } from "../components/detail/github.js";
import { DetailHero } from "../components/detail/hero.js";
import { DetailRelated } from "../components/detail/related.js";
import { DETAIL_HERO_END_ID, SectionTabs, sectionElementId, type DetailSection } from "../components/detail/section-nav.js";
import { ToolDetailShell } from "../components/detail/shell.js";
import { DetailSidebar } from "../components/detail/sidebar.js";
import { DetailSimilarCta } from "../components/detail/similar-cta.js";

type Page = Extract<TemplatePage, { kind: "detail" }>;
export function DetailPage({ page }: { page: Page }) {
  return (
    <Document page={page} seo={detailSeo(page)}>
      <SiteChrome>
        <main>
          <ToolDetail page={page} />
        </main>
      </SiteChrome>
    </Document>
  );
}

function ToolDetail({ page }: { page: Page }) {
  const t = useTranslations("tools");
  const td = useTranslations("tools.detail");
  const tq = useTranslations("qooim.catalog.github");
  const tm = useTranslations("qooim.catalog.detail");
  const tc = useTranslations("qooim.catalog.compare");
  const tool = page.item;
  const details = tool.details ?? {};
  const features = details.features ?? [];
  const useCases = details.useCases ?? [];
  const pros = details.pros ?? [];
  const cons = details.cons ?? [];
  const faqs = details.faqs ?? [];
  const categories = page.categories ?? [];
  const related = page.related ?? [];
  const comparisons = page.comparisons ?? [];
  const primaryCategory = tool.category_id ? categories.find((c) => c.id === tool.category_id) : undefined;

  // 实际会渲染的章节清单:目录、章节条、章节序号都以它为准。
  const nav: DetailSection[] = [];
  if (details.content) nav.push({ slug: "overview", title: tm("overview") });
  if (features.length > 0) nav.push({ slug: "features", title: tm("keyFeatures") });
  if (useCases.length > 0) nav.push({ slug: "use-cases", title: tm("useCases") });
  if (pros.length > 0 || cons.length > 0) nav.push({ slug: "pros-cons", title: tm("prosCons") });
  if (tool.project) nav.push({ slug: "github", title: tq("title") });
  if (faqs.length > 0) nav.push({ slug: "faq", title: td("faq") });
  if (comparisons.length > 0) nav.push({ slug: "comparisons", title: tc("title") });
  if (related.length > 0) nav.push({ slug: "related", title: td("relatedTools") });
  const secNo = (navSlug: string) => {
    const i = nav.findIndex((n) => n.slug === navSlug);
    return i >= 0 ? i + 1 : undefined;
  };

  return (
    <ToolDetailShell>
      {/* ====== 统一 grid：hero + 正文同列，右栏整列 sticky 全页 ====== */}
      {/* overflow-x-clip:下方封面模糊层 scale-110 会把页面横向撑宽(clip 不建滚动容器,不影响 sticky) */}
      <div className="relative overflow-x-clip">
        {/* 氛围层:本域统一背景(发丝网格 + 品牌色光晕) */}
        <Background />
        <div
          className="absolute top-0 inset-x-0 h-[720px] bg-gradient-to-b from-transparent via-background/50 to-background pointer-events-none"
          aria-hidden
        />

        <div className="relative mx-auto w-full max-w-7xl px-5 pb-16 pt-28 sm:px-8 md:pt-32">
          <DetailBreadcrumb tool={tool} primaryCategory={primaryCategory} />

          <div>
            <CategorySidebar
              categories={categories}
              activeCategorySlug={primaryCategory?.id ?? null}
              breakpoint="xl"
            />
            <div className="min-w-0">
              <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-stretch lg:gap-16">
            {/* ===== 左列：hero 头部 + 全部正文 ===== */}
            <div className="min-w-0 space-y-7">
              <DetailHero tool={tool} />

              {/* 英雄区到此为止 */}
              <div id={DETAIL_HERO_END_ID} aria-hidden className="!mt-0 h-0" />

              {/* 章节条(< lg):吸顶在浮动导航下方;桌面由右栏目录承担同样的职责 */}
              <SectionTabs label={td("contents")} sections={nav} />

              {/* ===== 正文 sections（仍在左列内）===== */}
              <div className="space-y-16 pt-10 md:space-y-20">
                {details.content && (
                  <DetailProseSection slug="overview" title={tm("overview")} index={secNo("overview")} body={details.content} />
                )}

                {features.length > 0 && (
                  <DetailProseSection slug="features" title={tm("keyFeatures")} index={secNo("features")} items={features} />
                )}

                {useCases.length > 0 && (
                  <DetailProseSection slug="use-cases" title={tm("useCases")} index={secNo("use-cases")} items={useCases} />
                )}

                {(pros.length > 0 || cons.length > 0) && (
                  <DetailProsCons
                    index={secNo("pros-cons")}
                    title={tm("prosCons")}
                    prosTitle={tm("pros")}
                    consTitle={tm("cons")}
                    pros={pros}
                    cons={cons}
                  />
                )}

                {tool.project && <DetailGithub slug="github" index={secNo("github")} project={tool.project} />}

                {faqs.length > 0 && <DetailFaq index={secNo("faq")} title={td("faq")} faq={faqs} />}

                {comparisons.length > 0 && <DetailComparisons index={secNo("comparisons")} comparisons={comparisons} />}

                <DetailSimilarCta />
              </div>{/* /正文 sections */}
            </div>{/* /左列 */}

            {/* ===== 右列：上半 Quick Info 跟随页面滚走；下半 Visit/TOC sticky ===== */}
            <DetailSidebar tool={tool} category={primaryCategory} canonical={page.canonical} sections={nav} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <DetailRelated related={related} primaryCategory={primaryCategory} id={sectionElementId("related")} slug={tool.slug} />
      )}

      <div className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8">
        <Link
          href={localePath("/tools")}
          className="group inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:-translate-x-1" />
          {t("backToTools")}
        </Link>
      </div>
    </ToolDetailShell>
  );
}
