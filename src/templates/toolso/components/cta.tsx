// Ported from toolso-ai-open src/components/cta.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: per-site CTA image (@/lib/sites/imagery) dropped; the glow uses the bg-primary class instead of an inline style (CSP); title/description are Qoo.IM copy (toolso's say "AI tool"), the button keeps cta.button; cordis namespace dropped.
import { ArrowRight } from "lucide-react";
import { useTranslations } from "../shims/next-intl.js";
import { LocaleLink } from "./locale-link.js";
import { Container } from "./container.js";

/**
 * 收尾 CTA:同色系「墨色」面板(前景色反转,不是突兀的 slate 深色块)+ 品牌色光晕。
 * 深色模式下前景色是近白 → 面板改用卡片色并描边,避免整块刺眼的白。
 */
export const CTA = () => {
  const t = useTranslations("cta");
  const tHome = useTranslations("qooim.home.cta");
  return (
    <section className="relative z-30 py-16 md:py-24">
      <Container>
        <div className="relative isolate overflow-hidden rounded-[1.75rem] bg-[hsl(var(--brand-h)_22%_9%)] ring-1 ring-white/10">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-32 -top-40 -z-10 h-[30rem] w-[40rem] rounded-full bg-primary opacity-40 blur-[110px]"
          />
          <div aria-hidden className="hairline-grid pointer-events-none absolute inset-0 -z-10 opacity-40 invert [mask-image:linear-gradient(to_right,#000,transparent_70%)]" />

          <div className="relative px-6 py-16 sm:px-12 md:py-24 lg:px-16">
            <h2 className="type-display max-w-[14ch] text-white">
              {tHome('title')}
            </h2>
            <p className="mt-6 max-w-[44ch] text-base leading-relaxed text-white/70 md:text-lg">
              {tHome('description')}
            </p>
            <LocaleLink
              href="/tools"
              className="group mt-10 inline-flex h-[3.25rem] items-center gap-3 rounded-full bg-white pl-7 pr-2 text-base font-medium text-[hsl(var(--brand-h)_22%_9%)] transition-transform duration-300 ease-expo hover:-translate-y-px active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--brand-h)_22%_9%)]"
            >
              {t('button')}
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[hsl(var(--brand-h)_22%_9%)] text-white transition-transform duration-500 ease-expo group-hover:rotate-[-45deg]">
                <ArrowRight className="h-4 w-4" />
              </span>
            </LocaleLink>
          </div>
        </div>
      </Container>
    </section>
  );
};
