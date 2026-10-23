/**
 * Per-site brand palette for the toolso template, served as /assets/theme/<hex>.css.
 * toolso wrote these variables into <html style>; the CSP forbids inline styles, so the
 * same values come from a cacheable stylesheet keyed by the validated hex color.
 */
function hsl(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2,
    d = max - min;
  let h = 0,
    s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h =
      max === r
        ? ((g - b) / d + (g < b ? 6 : 0)) * 60
        : max === g
          ? ((b - r) / d + 2) * 60
          : ((r - g) / d + 4) * 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function luminance(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function themeCss(hex: string) {
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error("Invalid theme color");
  const { h, s, l } = hsl(hex);
  const accent = `${h} ${s}% ${l}%`;
  const bright = luminance(hex) > 0.45;
  // Bright accents (e.g. lime) get dark text on buttons and a darker ink for text-primary.
  const vars = [
    `--brand-h:${h}`,
    `--brand-accent:#${hex}`,
    `--primary:${accent}`,
    `--primary-foreground:${bright ? `${h} 20% 8%` : "0 0% 100%"}`,
    `--ring:${accent}`,
    ...(bright ? [`--primary-ink-light:${h} ${s}% ${Math.min(l, 32)}%`] : []),
  ].join(";");
  // :root:root outranks the .dark token block, matching toolso's inline-style precedence.
  return `:root:root{${vars}}\n`;
}
