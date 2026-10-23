// Ported verbatim from toolso-ai-open src/components/safe-json-ld.tsx (Apache-2.0, Copyright 2025 CoolChange.AI).
/**
 * 用 dangerouslySetInnerHTML 注入 schema.org JSON-LD，
 * 把 <, >, &, U+2028, U+2029 转义掉，防止 script 标签截断和 JSON in HTML 边界问题。
 * (用 RegExp / String 构造避免 U+2028/U+2029 在源码里被当作行终止符。)
 */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const ESCAPE_RE = new RegExp("[<>&" + LS + PS + "]", "g");
const ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  [LS]: "\\u2028",
  [PS]: "\\u2029",
};

function safeStringify(value: unknown): string {
  return JSON.stringify(value).replace(ESCAPE_RE, (ch) => ESCAPES[ch] ?? ch);
}

export function SafeJsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeStringify(data) }}
    />
  );
}
