// Ported from toolso-ai-open src/components/footer.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: the site-network block (network-data logos, DR badges, pricing pitch) dropped from all four variants; links are the pages Qoo.IM has (tools, submit → /me) plus the site's configured navigation and configured about/privacy/terms/contact pages; brand-colour inline styles became text-primary/bg-primary classes (CSP); the wordmark size uses a literal class per name length (CJK counted double) instead of an inline font-size; copyright line carries the current year and site name; the operator's footer text (templateParams.footer) or the tagline is shown under the logo.
import { Logo } from "./logo.js";
import { useTranslations } from "../shims/next-intl.js";
import { LocaleLink } from "./locale-link.js";
import { useSite } from "../shims/site.js";
import { context } from "../runtime.js";

/**
 * 页脚:4 种「人格」布局,按站点 templateParams.motion 自动选,并染上站点品牌色(--primary)。
 * - minimal / crisp / playful / smooth(默认)。
 */

type FLink = { name: string; href: string; external?: boolean };
interface FooterData {
  note: string;
  copyright: string;
  rights: string;
  links: FLink[];
  legal: FLink[];
  socials: FLink[];
}

function LinkList({ items, className }: { items: FLink[]; className?: string }) {
  return (
    <>
      {items.map((l) =>
        l.external ? (
          <a key={l.name} href={l.href} target="_blank" rel="noopener noreferrer" className={className}>
            {l.name}
          </a>
        ) : (
          <LocaleLink key={l.name} href={l.href} className={className}>
            {l.name}
          </LocaleLink>
        ),
      )}
    </>
  );
}

const LINK_CLS = "link-sweep w-fit pb-0.5 hover:text-foreground text-muted-foreground text-sm";

/* ── smooth：均衡布局（默认） ── */
function FooterSmooth(d: FooterData) {
  return (
    <div className="relative border-t border-border bg-background px-5 pb-12 pt-20 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col items-start justify-between text-sm text-muted-foreground sm:flex-row">
          <div>
            <div className="mb-4 md:flex">
              <Logo />
            </div>
            {d.note && <p className="mb-4 max-w-[48ch]">{d.note}</p>}
            <div>{d.copyright}</div>
            <div className="mt-2">{d.rights}</div>
          </div>
          <div className="mt-10 grid grid-cols-2 items-start gap-x-16 gap-y-10 sm:grid-cols-3 md:mt-0">
            {[d.links, d.legal, d.socials]
              .filter((items) => items.length > 0)
              .map((items, i) => (
                <div key={i} className="mt-4 flex flex-col items-start space-y-4">
                  <LinkList items={items} className={LINK_CLS} />
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── minimal：极简居中、小 logo、单行链接、大留白 ── */
function FooterMinimal(d: FooterData) {
  const inline = [...d.links, ...d.legal, ...d.socials];
  return (
    <div className="border-t border-border bg-background px-5 pb-12 pt-16 text-center sm:px-8">
      <div className="mx-auto max-w-3xl">
        {d.note && <div className="mb-4 text-xs text-primary">{d.note}</div>}
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <LinkList items={inline} className="text-xs text-muted-foreground transition-colors hover:text-foreground" />
        </div>
        <div className="mt-8 text-xs text-muted-foreground/70">
          {d.copyright} · {d.rights}
        </div>
      </div>
    </div>
  );
}

/* ── crisp：accent 实心上条 + 分明多列 + 锐利分隔 ── */
function FooterCrisp(d: FooterData) {
  const rest = [...d.legal, ...d.socials];
  return (
    <div className="bg-background">
      <div className="h-1 w-full bg-primary" />
      <div className="px-5 pb-12 pt-16 sm:px-8">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 md:grid-cols-4 md:divide-x md:divide-border">
          <div className="md:pr-8">
            <Logo />
            <div className="mt-4 text-xs text-muted-foreground">{d.copyright}</div>
            <div className="mt-1 text-xs text-muted-foreground">{d.rights}</div>
          </div>
          {d.note && (
            <div className="md:px-8">
              <p className="text-sm leading-relaxed text-muted-foreground">{d.note}</p>
            </div>
          )}
          <div className="flex flex-col items-start space-y-3 md:px-8">
            <LinkList items={d.links} className={LINK_CLS} />
          </div>
          {rest.length > 0 && (
            <div className="flex flex-col items-start space-y-3 md:pl-8">
              <LinkList items={rest} className={LINK_CLS} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── playful：accent 渐变面板 + 圆角大 logo 卡 + 活泼 ── */
function FooterPlayful(d: FooterData) {
  return (
    <div className="bg-background px-5 pb-12 pt-10 sm:px-6">
      <div className="mx-auto max-w-7xl rounded-3xl border border-border bg-[linear-gradient(160deg,hsl(var(--primary)/0.08),transparent_60%)] p-8 sm:p-12">
        {d.note && <div className="mb-7 text-base font-semibold text-primary">{d.note}</div>}
        <div className="flex flex-col items-start justify-between gap-8 border-t border-border/60 pt-8 sm:flex-row sm:items-center">
          <div>
            <Logo />
            <div className="mt-3 text-xs text-muted-foreground">{d.copyright} · {d.rights}</div>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <LinkList items={[...d.links, ...d.legal, ...d.socials]} className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:text-sm" />
          </div>
        </div>
      </div>
    </div>
  );
}

// 字号按品牌名长度收敛(toolso: min(17rem, calc(160vw / max(len, 4)))),长名也不溢出视口。
// Literal classes so Tailwind generates them; index = clamped length - 4.
const WORDMARK_SIZE = [
  "text-[length:min(17rem,calc(160vw/4))]",
  "text-[length:min(17rem,calc(160vw/5))]",
  "text-[length:min(17rem,calc(160vw/6))]",
  "text-[length:min(17rem,calc(160vw/7))]",
  "text-[length:min(17rem,calc(160vw/8))]",
  "text-[length:min(17rem,calc(160vw/9))]",
  "text-[length:min(17rem,calc(160vw/10))]",
  "text-[length:min(17rem,calc(160vw/11))]",
  "text-[length:min(17rem,calc(160vw/12))]",
  "text-[length:min(17rem,calc(160vw/13))]",
  "text-[length:min(17rem,calc(160vw/14))]",
  "text-[length:min(17rem,calc(160vw/15))]",
  "text-[length:min(17rem,calc(160vw/16))]",
  "text-[length:min(17rem,calc(160vw/17))]",
  "text-[length:min(17rem,calc(160vw/18))]",
  "text-[length:min(17rem,calc(160vw/19))]",
  "text-[length:min(17rem,calc(160vw/20))]",
  "text-[length:min(17rem,calc(160vw/21))]",
  "text-[length:min(17rem,calc(160vw/22))]",
  "text-[length:min(17rem,calc(160vw/23))]",
  "text-[length:min(17rem,calc(160vw/24))]",
  "text-[length:min(17rem,calc(160vw/25))]",
  "text-[length:min(17rem,calc(160vw/26))]",
  "text-[length:min(17rem,calc(160vw/27))]",
  "text-[length:min(17rem,calc(160vw/28))]",
  "text-[length:min(17rem,calc(160vw/29))]",
  "text-[length:min(17rem,calc(160vw/30))]",
  "text-[length:min(17rem,calc(160vw/31))]",
  "text-[length:min(17rem,calc(160vw/32))]",
  "text-[length:min(17rem,calc(160vw/33))]",
  "text-[length:min(17rem,calc(160vw/34))]",
  "text-[length:min(17rem,calc(160vw/35))]",
  "text-[length:min(17rem,calc(160vw/36))]",
  "text-[length:min(17rem,calc(160vw/37))]",
  "text-[length:min(17rem,calc(160vw/38))]",
  "text-[length:min(17rem,calc(160vw/39))]",
  "text-[length:min(17rem,calc(160vw/40))]",
];
function wordmarkSize(name: string) {
  // CJK glyphs are about twice as wide as Latin ones in Geist's fallback fonts.
  const wide = (cp: number) =>
    (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);
  const length = [...name].reduce((n, ch) => n + (wide(ch.codePointAt(0) ?? 0) ? 2 : 1), 0);
  return WORDMARK_SIZE[Math.min(Math.max(length, 4), 40) - 4];
}

export const Footer = () => {
  const t = useTranslations();
  const site = useSite();
  const { page } = context();

  const links: FLink[] = [
    { name: t("navigation.main.tools"), href: "/tools" },
    { name: t("navigation.main.submit"), href: "/submit" },
    ...page.site.navigation.map((n) => ({ name: n.label, href: n.href })),
  ];
  const socials: FLink[] = [
    site.social?.twitter && { name: t("footer.social.twitter"), href: site.social.twitter, external: true },
    site.social?.github && { name: t("footer.social.github"), href: site.social.github, external: true },
  ].filter(Boolean) as FLink[];
  const locale = page.locale === "en" ? "en" : "zh";
  const legal: FLink[] = (["about", "privacy", "terms", "contact"] as const).flatMap((key) => {
    const copy = page.site.pages?.[key]?.[locale];
    return copy && key !== page.catalogPath
      ? [{ name: copy.title, href: `/${page.locale}/${key}` }]
      : [];
  });

  const data: FooterData = {
    note: page.site.templateParams?.footer || site.tagline,
    copyright: t("qooim.home.copyright", { year: new Date().getFullYear() }),
    rights: t("common.brand.allRightsReserved"),
    links,
    legal,
    socials,
  };

  const Variant =
    site.motion === "minimal"
      ? FooterMinimal
      : site.motion === "crisp"
        ? FooterCrisp
        : site.motion === "playful"
          ? FooterPlayful
          : FooterSmooth;

  return (
    <footer className="relative overflow-hidden bg-background">
      <Variant {...data} />
      {/* 巨型品牌字收尾:描边空心,悬停被品牌色自左填满;纯装饰,不进无障碍树 */}
      <div aria-hidden className="pointer-events-auto -mb-[0.12em] flex justify-center px-5 pb-24 sm:pb-0">
        <span className={`footer-wordmark ${wordmarkSize(site.brandName)}`}>
          {site.brandName}
        </span>
      </div>
    </footer>
  );
};
