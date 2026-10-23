// Ported from toolso-ai-open src/features/tools/lib/pricing.ts (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes Qoo.IM's fixed pricing values instead of free-text models ("trial" shows the freetrial label; "open-source" is new and labelled from qooim.catalog.pricing); no free-text fallback badge.
import type { PublicPricing } from "../../../../public/sdk.js";
import type { Translator } from "../../runtime.js";

export interface PricingBadge {
  value: PublicPricing;
  cls: string;
  gradient: string;
}

const PRICING_BADGE: Record<PublicPricing, Omit<PricingBadge, "value">> = {
  free: {
    cls: "text-emerald-700 dark:text-emerald-300 ring-emerald-500/40 bg-emerald-500/10",
    gradient: "from-emerald-500 to-teal-500",
  },
  freemium: {
    cls: "text-sky-700 dark:text-sky-300 ring-sky-500/40 bg-sky-500/10",
    gradient: "from-sky-500 to-indigo-500",
  },
  trial: {
    cls: "text-amber-700 dark:text-amber-300 ring-amber-500/40 bg-amber-500/10",
    gradient: "from-amber-500 to-orange-500",
  },
  paid: {
    cls: "text-rose-700 dark:text-rose-300 ring-rose-500/40 bg-rose-500/10",
    gradient: "from-rose-500 to-pink-500",
  },
  contact: {
    cls: "text-violet-700 dark:text-violet-300 ring-violet-500/40 bg-violet-500/10",
    gradient: "from-violet-500 to-purple-500",
  },
  "open-source": {
    cls: "text-teal-700 dark:text-teal-300 ring-teal-500/40 bg-teal-500/10",
    gradient: "from-teal-500 to-emerald-600",
  },
};

export function pricingBadge(value: PublicPricing | null | undefined): PricingBadge | null {
  if (!value || !(value in PRICING_BADGE)) return null;
  return { value, ...PRICING_BADGE[value] };
}

/** Localized label: toolso's tools.pricing.* keys, plus qooim.catalog.pricing for open-source. */
export function pricingLabel(badge: PricingBadge, t: Translator): string {
  if (badge.value === "open-source") return t("qooim.catalog.pricing.openSource");
  return t(`tools.pricing.${badge.value === "trial" ? "freetrial" : badge.value}`);
}
