// Ported from toolso-ai-open src/features/tools/components/detail/breadcrumb.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: takes the resource and its category from page data; links via localePath; translators from the next-intl shim; aria-label added.
import { ChevronRight } from "lucide-react";
import type { PublicCategory, PublicResource } from "../../../../public/sdk.js";
import Link from "../../shims/next-link.js";
import { useTranslations } from "../../shims/next-intl.js";
import { localePath } from "../../runtime.js";

/** 详情页顶部面包屑:首页 → 列表 → 主分类 → 当前工具。 */
export function DetailBreadcrumb({
  tool,
  primaryCategory,
}: {
  tool: PublicResource;
  primaryCategory?: PublicCategory;
}) {
  const t = useTranslations("tools");
  const td = useTranslations("tools.detail");
  const tcommon = useTranslations("common");
  return (
    <nav aria-label={tcommon("breadcrumb")} className="eyebrow mb-8 flex flex-wrap items-center gap-2">
      <Link href={localePath("/")} className="hover:text-foreground transition-colors">
        {td("home")}
      </Link>
      <ChevronRight className="h-3 w-3" />
      <Link href={localePath("/tools")} className="hover:text-foreground transition-colors">
        {t("title")}
      </Link>
      {primaryCategory && (
        <>
          <ChevronRight className="h-3 w-3" />
          <Link
            href={localePath(`/category/${primaryCategory.id}`)}
            className="hover:text-foreground transition-colors"
          >
            {primaryCategory.label}
          </Link>
        </>
      )}
      <ChevronRight className="h-3 w-3" />
      <span aria-current="page" className="text-foreground font-medium truncate">{tool.title}</span>
    </nav>
  );
}
