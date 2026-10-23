// Ported from toolso-ai-open src/features/tools/components/related-carousel.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes PublicResources; links via localePath; initial-letter avatar (no logos); GitHub stars/language replace the pricing footer; RelatedCarouselControls (related-carousel-controls.tsx) dropped, since its scroll buttons need client code outside the toolso.js hook contract; the row still scrolls natively with scroll-snap.
import { Star } from "lucide-react";
import type { PublicResource } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useLocale, useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";
import { plainText } from "../catalog/plain-text.js";
import { compactNumber, domainOf } from "../catalog/resource.js";

interface Props {
  tools: PublicResource[];
}

const VIEWPORT_ID = "related-tools-carousel";

export function RelatedCarousel({ tools }: Props) {
  const locale = useLocale();
  const tq = useTranslations("qooim.catalog.github");
  return (
    <div className="relative">
      <div
        id={VIEWPORT_ID}
        className="overflow-x-auto scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <div data-spotlight className="flex snap-x snap-mandatory gap-4 px-px pb-8 pt-2">
          {tools.map((r) => {
            const domain = domainOf(r.url);
            return (
              <Link
                key={r.resource_id}
                href={localePath(`/tools/${r.slug}`)}
                className="surface-card group w-[280px] shrink-0 snap-start p-5"
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className="h-10 w-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                    <span className="text-base font-semibold text-muted-foreground">
                      {r.title.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold tracking-tight text-foreground">
                      {r.title}
                    </h3>
                    {domain && (
                      <p className="num truncate text-xs text-muted-foreground">{domain}</p>
                    )}
                  </div>
                </div>
                {r.description && (
                  <p className="mb-4 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                    {plainText(r.description)}
                  </p>
                )}
                {r.project && (
                  <span className="eyebrow inline-flex items-center gap-2 border-t border-border/70 pt-3.5 !text-[0.625rem] text-foreground/80 w-full">
                    <Star aria-hidden className="h-3 w-3" />
                    <span className="sr-only">{tq("stars")}</span>
                    <span className="num">{compactNumber(r.project.stars, locale)}</span>
                    {r.project.language && <span className="normal-case">· {r.project.language}</span>}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
