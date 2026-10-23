// Ported from toolso-ai-open src/features/tools/components/detail/related.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes page data (same-category items); links via localePath; the block carries a section id so the contents list can point at it.
import { ArrowRight } from "lucide-react";
import type { PublicCategory, PublicResource } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";
import { SectionHeader, sectionLinkClass } from "../section-header.js";
import { RelatedCarousel } from "./related-carousel.js";

/** 页面底部的「相关工具」横向轮播(同分类的其它工具)。 */
export function DetailRelated({
  related,
  primaryCategory,
  id,
}: {
  related: PublicResource[];
  primaryCategory?: PublicCategory;
  id?: string;
}) {
  const td = useTranslations("tools.detail");
  return (
    <div id={id} className="detail-section bg-secondary/40">
      <div className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8 md:py-24">
        <SectionHeader
          title={td("relatedTools")}
          className="mb-10"
          action={
            primaryCategory ? (
              <Link
                href={localePath(`/category/${primaryCategory.id}`)}
                className={sectionLinkClass}
              >
                {td("viewAll")}
                <ArrowRight className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:translate-x-1" />
              </Link>
            ) : undefined
          }
        />
        <RelatedCarousel tools={related} />
      </div>
    </div>
  );
}
