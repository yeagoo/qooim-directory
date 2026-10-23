// Ported from toolso-ai-open src/components/hero.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: per-site hero image (@/lib/sites/imagery) dropped, so the text column always takes the no-image width; the title is the site tagline (generic Qoo.IM copy when empty) and the description Qoo.IM copy, instead of toolso's AI-tools strings; the secondary button goes to submissions (/submit → /me) since there is no blog; site is always present.
import { Button } from "./button.js";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Reveal } from "./reveal.js";

import { LocaleLink } from "./locale-link.js";
import { useTranslations } from "../shims/next-intl.js";
import { useSite } from "../shims/site.js";

const SPLIT_STAT = /^\s*([\d][\d.,\s  ]*)\s*(.*)$/;

/** 「1,004 tools」→ 数字与标签拆开排(数字用等宽大号);拆不动就整体当标签。 */
function splitStat(text: string): { value: string | null; label: string } {
  const m = text.match(SPLIT_STAT);
  if (!m || !m[2]) return { value: null, label: text };
  return { value: m[1]!.trim(), label: m[2].trim() };
}

export const Hero = ({ stats = [], intro }: { stats?: string[]; intro?: string }) => {
  const t = useTranslations('hero');
  const tHome = useTranslations('qooim.home.hero');
  const tNav = useTranslations('navigation.main');
  const site = useSite();
  return (
    <div className="relative w-full">
      <div className="grid items-end gap-x-10 gap-y-12 lg:grid-cols-12">
        <div className="lg:col-span-10">
          <Reveal index={0} y={16} className="eyebrow flex items-center gap-3">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            <span className="text-foreground">{site.brandName}</span>
            {stats[0] && (
              <>
                <span aria-hidden className="h-px w-6 bg-border" />
                <span>{stats[0]}</span>
              </>
            )}
          </Reveal>
          <Reveal as="h1" index={1} y={36} className="type-display mt-7 text-foreground">
            {site.tagline || tHome('title')}
          </Reveal>
          <Reveal
            as="p"
            index={2}
            y={28}
            className="mt-7 max-w-[54ch] text-lg leading-relaxed text-muted-foreground md:text-xl md:leading-relaxed"
          >
            {tHome('description')}
          </Reveal>
          <Reveal index={3} y={24} className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-4">
            <Button as={LocaleLink} href="/tools" size="lg" className="group">
              <span>{t('cta.primary')}</span>
              <ArrowRight className="h-4 w-4 transition-transform duration-300 ease-expo group-hover:translate-x-1" />
            </Button>
            <Button variant="simple" size="lg" as={LocaleLink} href="/submit" className="group">
              <span>{tNav('submit')}</span>
              <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-transform duration-300 ease-expo group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Button>
          </Reveal>
        </div>
      </div>

      {(intro || stats.length > 0) && (
        <Reveal
          index={4}
          y={20}
          className="mt-16 grid gap-x-10 gap-y-8 border-t border-border pt-8 md:mt-24 lg:grid-cols-12"
        >
          {intro && (
            <p className="max-w-[62ch] text-base leading-relaxed text-muted-foreground lg:col-span-7">
              {intro}
            </p>
          )}
          {stats.length > 0 && (
            <dl className={`flex flex-wrap gap-x-12 gap-y-6 lg:col-span-5 lg:justify-end ${intro ? "" : "lg:col-start-8"}`}>
              {stats.map((s) => {
                const { value, label } = splitStat(s);
                return (
                  <div key={s} className="flex flex-col-reverse gap-1.5">
                    <dt className="eyebrow">{label}</dt>
                    {value && <dd className="text-3xl font-medium tabular-nums tracking-tight text-foreground md:text-[2.5rem] md:leading-none">{value}</dd>}
                  </div>
                );
              })}
            </dl>
          )}
        </Reveal>
      )}
    </div>
  );
};
