// Ported from toolso-ai-open src/components/locale-link.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: internal paths are mapped by runtime.localePath to Qoo.IM URLs (replaces aliasPath and default-locale prefixing); plain <a> via the next/link shim instead of next-view-transitions.
import type { AnchorHTMLAttributes, ReactNode } from "react";
import Link from "../shims/next-link.js";
import { localePath } from "../runtime.js";

type LocaleLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children: ReactNode;
  className?: string;
};

export function LocaleLink({ href, children, ...props }: LocaleLinkProps) {
  if (href.startsWith("http") || href.startsWith("//")) {
    return <Link href={href} {...props}>{children}</Link>;
  }

  const rawHref = href.startsWith("/") ? href : `/${href}`;
  return <Link href={localePath(rawHref)} {...props}>{children}</Link>;
}
