// Qoo.IM glue: derives the fields toolso's components read (domain, compact counts) from a
// PublicResource. Qoo.IM has no logo, pricing or tags; components hide what is missing.
/** Host of the resource URL without "www.", like toolso's `tool.domain`; null when unparsable. */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return null;
    return hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Only http(s) URLs become outbound links (toolso's safeExternalUrl). */
export function externalUrl(url: string | null | undefined): string | null {
  return domainOf(url) ? url! : null;
}

export function compactNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDate(value: string | null | undefined, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
