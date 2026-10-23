// Ported from toolso-ai-open src/components/Logo.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: links to this locale's home through LocaleLink; the cordis compact brand and the inverse (marketplace hero) treatment dropped; LogoIcon renders nothing because Qoo.IM sites have no logo field.
import { LocaleLink } from "./locale-link.js";
import { useSite } from "../shims/site.js";
import Image from "../shims/next-image.js";
import { cn } from "../lib/utils.js";

/** 当前站点的品牌标记(站点配置了 logo 时)。 */
export const LogoIcon = ({
  className = "h-6 w-6",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) => {
  const site = useSite();
  if (!site.logo) return null;
  return (
    <Image
      src={site.logo}
      alt={decorative ? "" : site.brandName}
      width={24}
      height={24}
      className={`${className} rounded-md`}
      unoptimized
      priority
    />
  );
};

export const Logo = ({ className }: { className?: string }) => {
  const site = useSite();
  return (
    <LocaleLink
      href="/"
      aria-label={site.brandName}
      className={cn(
        "relative z-20 mr-4 flex shrink-0 items-center space-x-2 px-2 py-1 text-sm font-normal text-foreground",
        className,
      )}
    >
      <LogoIcon decorative />
      <span className="whitespace-nowrap font-medium text-foreground">{site.brandName}</span>
    </LocaleLink>
  );
};
