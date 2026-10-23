// Ported verbatim from toolso-ai-open src/lib/plain-text.ts (Apache-2.0, Copyright 2025 CoolChange.AI).
/** Compact excerpts only; React still escapes the resulting text. Not an HTML sanitizer. */
export function plainText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/g, " ")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ").trim();
}
