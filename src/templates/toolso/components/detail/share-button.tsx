// Ported from toolso-ai-open src/features/tools/components/share-button.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: open/close, Escape and outside-click handling come from the [data-toggle] hook of /assets/toolso.js; "copy link" uses [data-copy] with the toast text passed as data attributes; no client state.

import { Link as LinkIcon, Send, Share2, Twitter } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  url: string;
  title: string;
  ariaLabel: string;
  labels: {
    copyLink: string;
    copied: string;
    copyFailed: string;
  };
}

export function ShareButton({ url, title, ariaLabel, labels }: Props) {
  const links: Array<{ key: string; label: string; icon: ReactNode; href: string }> = [
    {
      key: "twitter",
      label: "X / Twitter",
      icon: <Twitter className="h-4 w-4" />,
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`,
    },
    {
      key: "telegram",
      label: "Telegram",
      icon: <Send className="h-4 w-4" />,
      href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
    },
  ];

  return (
    <div className="relative">
      <button
        type="button"
        data-toggle="share-menu"
        aria-controls="share-menu"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={ariaLabel}
        title={ariaLabel}
        className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-all duration-300 ease-expo hover:border-foreground/40 hover:text-foreground active:scale-90"
      >
        <Share2 className="h-5 w-5" />
      </button>
      <div
        id="share-menu"
        hidden
        role="menu"
        aria-label={ariaLabel}
        className="absolute right-0 top-full mt-2 w-48 rounded-2xl bg-popover border border-border shadow-lift z-40 p-1.5"
      >
        <button
          type="button"
          role="menuitem"
          data-copy={url}
          data-copied-label={labels.copied}
          data-failed-label={labels.copyFailed}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary focus:bg-secondary focus:outline-none transition-colors"
        >
          <LinkIcon className="h-4 w-4" />
          {labels.copyLink}
        </button>
        {links.map((l) => (
          <a
            key={l.key}
            role="menuitem"
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-secondary focus:bg-secondary focus:outline-none transition-colors"
          >
            {l.icon}
            {l.label}
          </a>
        ))}
      </div>
    </div>
  );
}
