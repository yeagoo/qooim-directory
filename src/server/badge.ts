const invalidXml = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const escapeXml = (value: string) =>
  value.replace(invalidXml, "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const wide = /[\u1100-\u115f\u2e80-\u303e\u3040-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1faff}]/u;
const widthOf = (value: string) =>
  Array.from(value).reduce((total, character) => total + (wide.test(character) ? 2 : 1), 0);
const shorten = (value: string, maxWidth: number) => {
  let width = 0;
  let output = "";
  for (const character of Array.from(value.replace(/\s+/g, " ").trim())) {
    const next = width + widthOf(character);
    if (next > maxWidth) break;
    output += character;
    width = next;
  }
  return output;
};
const LABEL_WIDTH = 28;
const TITLE_WIDTH = 22;

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
    LABEL_WIDTH,
  );
  const title = shorten(input.title, TITLE_WIDTH);
  const colors = dark
    ? { background: "#18181b", border: "#3f3f46", text: "#f4f4f5", muted: "#a1a1aa" }
    : { background: "#ffffff", border: "#d4d4d8", text: "#18181b", muted: "#52525b" };
  const accessible = `${label}: ${title}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="64" viewBox="0 0 256 64" role="img" aria-label="${escapeXml(accessible)}"><title>${escapeXml(accessible)}</title><rect x="0.5" y="0.5" width="255" height="63" rx="11" fill="${colors.background}" stroke="${colors.border}"/><rect x="0" y="10" width="5" height="44" rx="2.5" fill="${accent}"/><circle cx="28" cy="24" r="5" fill="${accent}"/><text x="41" y="28" fill="${colors.muted}" font-family="system-ui,-apple-system,sans-serif" font-size="11" font-weight="600">${escapeXml(label)}</text><text x="20" y="47" fill="${colors.text}" font-family="system-ui,-apple-system,sans-serif" font-size="15" font-weight="600">${escapeXml(title)}</text></svg>`;
}
