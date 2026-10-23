// Ported from toolso-ai-open src/features/navigation/components/categories-menu.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: no client state — the trigger is a [data-toggle] button and the popup is rendered `hidden` (src/ui/toolso.js toggles it, incl. Escape and outside click); open-state styles moved to aria-expanded: variants; CategoryIcon via catalog/category-icon; inverse treatment dropped.
import { ChevronDown } from "lucide-react";
import { LocaleLink } from "../locale-link.js";
import { CategoryIcon } from "./category-mark.js";

export interface CategoryMenuItem {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  count: number;
}

interface Props {
  /** 分类列表（已按需排序）。建议传 top-18 + 全量 fallback */
  items: CategoryMenuItem[];
  triggerLabel: string;
  viewAllLabel: string;
  id?: string;
}

const MAX_VISIBLE = 18;

export function CategoriesMenu({ items, triggerLabel, viewAllLabel, id = "categories-menu" }: Props) {
  const visible = items.slice(0, MAX_VISIBLE);
  const hasMore = items.length > MAX_VISIBLE;

  return (
    <div className="relative">
      <button
        type="button"
        data-toggle={id}
        aria-controls={id}
        aria-expanded="false"
        aria-haspopup="menu"
        className="group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-sm leading-[110%] text-foreground/85 transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-primary/[0.08] aria-expanded:text-foreground aria-expanded:ring-1 aria-expanded:ring-primary/10 2xl:px-4"
      >
        <span className="font-medium">{triggerLabel}</span>
        <ChevronDown
          className="h-4 w-4 text-foreground/70 transition-transform duration-150 group-hover:text-foreground group-aria-expanded:rotate-180 group-aria-expanded:text-foreground"
          strokeWidth={2.5}
        />
      </button>

      <div
        id={id}
        hidden
        role="menu"
        // 居中向下 popup，自适应宽度
        className="absolute left-1/2 top-full z-50 mt-3 w-[min(640px,90vw)] -translate-x-1/2 animate-[category-menu-in_0.12s_ease-out_both] origin-top rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
      >
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 sm:grid-cols-3">
          {visible.map((c) => (
            <LocaleLink
              key={c.id}
              href={`/category/${c.slug}`}
              role="menuitem"
              className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <span className="flex min-w-0 items-center gap-2">
                <CategoryIcon
                  slug={c.slug}
                  size={16}
                  className="shrink-0 opacity-80"
                />
                <span className="truncate">{c.name}</span>
              </span>
              <span className="shrink-0 text-xs opacity-50">{c.count}</span>
            </LocaleLink>
          ))}
        </div>

        {hasMore ? (
          <>
            <div className="my-2 h-px bg-border/60" aria-hidden />
            <LocaleLink
              href="/category"
              role="menuitem"
              className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground hover:bg-hover"
            >
              {viewAllLabel} ({items.length}) →
            </LocaleLink>
          </>
        ) : null}
      </div>
    </div>
  );
}
