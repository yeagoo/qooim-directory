// Stand-in for next/link: a plain anchor. Prefetch and scroll options have no meaning here.
import type { AnchorHTMLAttributes, ReactNode } from "react";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string | { pathname?: string; query?: Record<string, string> };
  children?: ReactNode;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
};
export default function Link({ href, prefetch: _p, scroll: _s, replace: _r, children, ...rest }: Props) {
  const url =
    typeof href === "string"
      ? href
      : (href.pathname ?? "") + (href.query ? "?" + new URLSearchParams(href.query) : "");
  return (
    <a href={url} {...rest}>
      {children}
    </a>
  );
}
