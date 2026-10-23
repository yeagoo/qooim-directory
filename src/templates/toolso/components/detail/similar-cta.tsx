// Ported from toolso-ai-open src/features/tools/components/detail/similar-cta.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: links to Qoo.IM's submission page via localePath("/submit") (no ?similar= prefill); the hint is a Qoo.IM string (toolso's mentions AI tools); the outline Button is inlined as its classes.
import { Plus } from "lucide-react";
import Link from "../../shims/next-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";

/** 正文末尾的提交引导。 */
export function DetailSimilarCta() {
  const td = useTranslations("tools.detail");
  const tq = useTranslations("qooim.catalog");
  return (
    <section className="flex flex-col gap-6 rounded-[1.75rem] border border-border bg-card p-7 sm:flex-row sm:items-center sm:justify-between sm:p-9">
      <div>
        <h3 className="text-xl font-semibold tracking-tight text-foreground">{td("knowSimilar")}</h3>
        <p className="mt-2 max-w-[48ch] text-[0.9375rem] leading-relaxed text-muted-foreground">{tq("submitSimilarHint")}</p>
      </div>
      <Link
        href={localePath("/submit")}
        rel="nofollow"
        className="relative z-10 inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border bg-background px-7 h-[3.25rem] text-base font-medium text-foreground transition-[background-color,color,border-color,box-shadow,transform] duration-300 ease-expo hover:border-foreground hover:bg-foreground hover:text-background active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Plus className="h-4 w-4" />
        {td("submitTool")}
      </Link>
    </section>
  );
}
