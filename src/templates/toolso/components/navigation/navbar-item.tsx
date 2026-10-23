// Ported from toolso-ai-open src/features/navigation/components/navbar-item.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: active state compares the current path with the localePath() target (replaces aliasPath + includes), and sets aria-current; inverse treatment dropped.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { LocaleLink } from "../locale-link.js";
import { usePathname } from "../../shims/next-navigation.js";
import { localePath } from "../../runtime.js";

type Props = {
  href: string;
  children: ReactNode;
  active?: boolean;
  className?: string;
  target?: "_blank";
};

export function NavBarItem({
  children,
  href,
  active,
  target,
  className,
}: Props) {
  const pathname = usePathname();
  const matchHref = localePath(href);

  const isActive = active || pathname === matchHref || pathname.startsWith(`${matchHref}/`);

  return (
    <LocaleLink
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3 py-2 text-sm leading-[110%] transition-colors focus-visible:outline-none focus-visible:ring-2 2xl:px-4",
        isActive
          ? "bg-primary/[0.08] text-foreground ring-1 ring-primary/10 focus-visible:ring-ring"
          : "text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring",
        className
      )}
      target={target}
    >
      {children}
    </LocaleLink>
  );
}
