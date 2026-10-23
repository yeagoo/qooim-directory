const invalidXml = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const escapeXml = (value: string) =>
  value.replace(invalidXml, "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const shorten = (value: string, max: number) =>
  Array.from(value.replace(/\s+/g, " ").trim()).slice(0, max).join("");

export function badgeSvg(input: {
  locale: "zh" | "en";
  siteName: string;
  title: string;
  theme: "light" | "dark";
  accentColor?: string;
}) {
  const accent = input.accentColor ?? "#286747";
  const dark = input.theme === "dark";
  const label = shorten(
    input.locale === "zh" ? `收录于 ${input.siteName}` : `Featured on ${input.siteName}`,
    38,
  );
  const title = shorten(input.title, 40);
  const colors = dark
    ? { background: "#18181b", border: "#3f3f46", text: "#f4f4f5", muted: "#a1a1aa" }
    : { background: "#ffffff", border: "#d4d4d8", text: "#18181b", muted: "#52525b" };
  const accessible = `${label}: ${title}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="64" viewBox="0 0 256 64" role="img" aria-label="${escapeXml(accessible)}"><title>${escapeXml(accessible)}</title><rect x="0.5" y="0.5" width="255" height="63" rx="11" fill="${colors.background}" stroke="${colors.border}"/><rect x="0" y="10" width="5" height="44" rx="2.5" fill="${accent}"/><circle cx="28" cy="24" r="5" fill="${accent}"/><text x="41" y="28" fill="${colors.muted}" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600">${escapeXml(label)}</text><text x="20" y="47" fill="${colors.text}" font-family="system-ui,-apple-system,sans-serif" font-size="15" font-weight="600">${escapeXml(title)}</text></svg>`;
}
