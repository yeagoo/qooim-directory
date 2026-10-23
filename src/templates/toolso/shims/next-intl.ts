// Stand-in for next-intl: same call shapes, backed by the render context (see runtime.ts).
// getTranslations is synchronous here; ported server components drop their `await`.
import { context, translator, type Locale } from "../runtime.js";

export const useTranslations = (namespace?: string) => translator(namespace);
export const useLocale = (): Locale => context().locale;
export const getTranslations = (
  options?: string | { locale?: string; namespace?: string },
) =>
  typeof options === "string"
    ? translator(options)
    : translator(options?.namespace, options?.locale === "en" ? "en" : options?.locale === "zh" ? "zh" : undefined);
