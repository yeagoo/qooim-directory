// Ported from toolso-ai-open src/app/[locale]/(marketing)/page.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: generic-directory branch only (cordis, nexablocks and upperstory homes dropped); synchronous, data from TemplateHomePage instead of DB queries; fixed section order featured → categories → cta (toolso read it from site.curation.homeSections), where the site's curated collections (TemplateHomePage.collections, toolso's tool_collection) replace the featured block with one block per collection (label, description, curated order, link to the collection page), and featured stays when there are none; featured keeps toolso's default count of 8 in the server's order (no siteSeededOrder shuffle, no lead categories); no per-site intro/FAQ (getSiteCopy) and no per-site imagery; JSON-LD and metadata are left to lib/seo.ts; the root is <main> because SiteChrome has no <main> of its own.
import type { TemplateHomePage } from "../../../public/sdk.js";
import { Document } from "../document.js";
import { homeSeo } from "../lib/seo.js";
import { SiteChrome } from "../components/site-chrome.js";
import { Container } from "../components/container.js";
import { Hero } from "../components/hero.js";
import { Background } from "../components/background.js";
import { CTA } from "../components/cta.js";
import { FeaturedTools } from "../components/featured-tools.js";
import { HomeCategories } from "../components/home-categories.js";
import { getTranslations } from "../shims/next-intl.js";

const FEATURED_COUNT = 8;
type Section = "featured" | "categories" | "cta" | `collection:${string}`;

export function HomePage({ page }: { page: TemplateHomePage }) {
  return (
    <Document page={page} seo={homeSeo(page)}>
      <SiteChrome>
        <Home page={page} />
      </SiteChrome>
    </Document>
  );
}

// Runs inside <Document>, after it has installed the render context.
function Home({ page }: { page: TemplateHomePage }) {
  const tt = getTranslations("tools");
  const tHome = getTranslations("qooim.home");
  const tc = getTranslations("qooim.catalog.collection");

  // 有工具的分类按工具数排序 → 分类条/分类版块突出热门分类
  const categories = page.categories
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
  const tools = page.featured.slice(0, FEATURED_COUNT);
  const collections = (page.collections ?? []).filter((c) => c.items.length > 0);
  const SECTIONS: Section[] = [
    ...(collections.length ? collections.map((c) => `collection:${c.id}` as const) : ["featured" as const]),
    "categories",
    "cta",
  ];

  // 版块序号(「01」「02」…):按实际渲染顺序编号
  const sectionNo = (kind: Section) => String(SECTIONS.indexOf(kind) + 1).padStart(2, "0");
  const categoryData = categories.map((c) => ({ id: c.id, slug: c.id, name: c.label, toolCount: c.count }));

  const renderSection = (kind: Section) => {
    if (kind.startsWith("collection:")) {
      const collection = collections.find((c) => `collection:${c.id}` === kind)!;
      return (
        <section key={kind} id={`collection-${collection.id}`} className="relative py-16 md:py-24">
          <Container>
            <FeaturedTools
              tools={collection.items.slice(0, FEATURED_COUNT)}
              categories={categoryData}
              index={sectionNo(kind)}
              showCategories={false}
              href={`/collection/${collection.id}`}
              labels={{
                featuredTitle: collection.label,
                featuredSubtitle: collection.description,
                visitWebsite: tt("visitWebsite"),
                noTools: tt("noTools"),
                viewAllTools: tc("viewList"),
              }}
            />
          </Container>
        </section>
      );
    }
    switch (kind) {
      case "featured":
        return (
          <section key="featured" className="relative py-16 md:py-24">
            <Container>
              <FeaturedTools
                tools={tools}
                categories={categoryData}
                index={sectionNo("featured")}
                showCategories={!SECTIONS.includes("categories")}
                labels={{
                  featuredTitle: tt("featuredTitle"),
                  featuredSubtitle: tHome("featuredSubtitle"),
                  visitWebsite: tt("visitWebsite"),
                  noTools: tt("noTools"),
                  viewAllTools: tt("category.viewAllTools"),
                }}
              />
            </Container>
          </section>
        );
      case "categories":
        return (
          <HomeCategories
            key="categories"
            categories={categories}
            total={categories.length}
            index={sectionNo("categories")}
          />
        );
      case "cta":
        return <CTA key="cta" />;
    }
  };

  return (
    <main className="relative">
      {/* Background 放在最外层，覆盖整个页面 */}
      <Background />

      <Container className="relative z-10 pb-12 pt-32 md:pb-20 md:pt-44">
        <Hero
          stats={[
            tt("category.toolsCount", { count: page.total }),
            tt("category.indexCount", { count: categories.length }),
          ]}
        />
      </Container>

      {/* 其余版块按顺序渲染 */}
      {SECTIONS.map(renderSection)}
    </main>
  );
}
