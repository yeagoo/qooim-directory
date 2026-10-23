// Stand-in for next/navigation during static rendering.
import { context } from "../runtime.js";

export const usePathname = () => new URL(context().page.canonical).pathname;
export const useSearchParams = () => {
  const page = context().page;
  const params = new URLSearchParams();
  if (page.kind === "directory") {
    if (page.q) params.set("q", page.q);
    if (page.category && !page.categoryPage) params.set("category", page.category);
    if (page.result.page > 1) params.set("page", String(page.result.page));
  }
  return params;
};
export const useRouter = () => ({
  push: (_href: string) => {},
  replace: (_href: string) => {},
  refresh: () => {},
  back: () => {},
  prefetch: (_href: string) => {},
});
