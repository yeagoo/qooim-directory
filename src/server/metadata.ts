import type { Pool } from "pg";
import { transaction } from "../domain/transaction.js";
import { webUrl } from "./content.js";
import { HttpError } from "./operators.js";
import { fetchPublicText, publicUrl, UnsafePublicTarget } from "./outbound.js";

export type PageMetadata = { title: string; description: string };
export type TextFetcher = typeof fetchPublicText;

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
function decodeEntities(value: string) {
  return value.replace(
    /&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/gi,
    (whole, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (named) return entities[named.toLowerCase()] ?? whole;
      const code = hex ? parseInt(hex, 16) : parseInt(decimal!, 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return whole;
      return String.fromCodePoint(code);
    },
  );
}
const plain = (value: string) =>
  decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const limit = (value: string, max: number) => Array.from(value).slice(0, max).join("");
function head(html: string) {
  const open = /<head\b[^>]*>/i.exec(html);
  if (!open) return "";
  const start = open.index + open[0].length;
  // Strip non-metadata blocks before looking for </head>, so a fake end tag in a
  // script cannot truncate the region. Unterminated blocks extend to the bound.
  const region = html
    .slice(start, start + 512 * 1024)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(
      /<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/gi,
      " ",
    );
  const close = /<\/head\s*>/i.exec(region);
  return close ? region.slice(0, close.index) : region;
}
function attribute(tag: string, name: string) {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "i",
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

/** Extract submission fields from the bounded <head>; never returns HTML. */
export function parseMetadata(html: string): PageMetadata {
  const region = head(html);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(region)?.[1] ?? "";
  const standardTitle = plain(titleTag);
  let standardDescription = "";
  let ogTitle = "";
  let ogDescription = "";
  for (const meta of region.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const key = (attribute(meta, "property") || attribute(meta, "name")).trim().toLowerCase();
    const content = attribute(meta, "content");
    if (key === "og:title" && !ogTitle) ogTitle = plain(content);
    else if (key === "og:description" && !ogDescription) ogDescription = plain(content);
    else if (key === "description" && !standardDescription) standardDescription = plain(content);
  }
  return {
    title: limit(ogTitle || standardTitle, 200),
    description: limit(ogDescription || standardDescription, 5000),
  };
}

export class MetadataService {
  constructor(
    private readonly pool: Pool,
    public fetcher: TextFetcher = fetchPublicText,
  ) {}

  private async reserve(siteId: string, userId: string) {
    await transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "metadata:" + siteId + ":" + userId,
      ]);
      const recent = (
        await client.query(
          `WITH cutoff AS MATERIALIZED (SELECT clock_timestamp()-interval '1 hour' AS at)
           SELECT count(*)::int AS n FROM metadata_fetch
           WHERE site_id=$1 AND user_id=$2 AND created_at>(SELECT at FROM cutoff)`,
          [siteId, userId],
        )
      ).rows[0].n;
      if (recent >= 20)
        throw new HttpError(429, "每小时最多自动获取 20 次，请稍后再试");
      await client.query(
        "DELETE FROM metadata_fetch WHERE site_id=$1 AND user_id=$2 AND created_at<clock_timestamp()-interval '1 day'",
        [siteId, userId],
      );
      await client.query(
        "INSERT INTO metadata_fetch(site_id,user_id,created_at) VALUES($1,$2,clock_timestamp())",
        [siteId, userId],
      );
    });
  }

  async fetch(
    input: unknown,
    quota?: { siteId: string; userId: string },
  ): Promise<PageMetadata> {
    const url = webUrl.parse(input);
    try {
      publicUrl(url);
    } catch {
      throw new HttpError(400, "请输入公开的 HTTPS 网站地址");
    }
    if (quota) await this.reserve(quota.siteId, quota.userId);
    let text: string;
    try {
      ({ text } = await this.fetcher(url, {
        maxBytes: 1024 * 1024,
        timeoutMs: 8000,
        // fetchPublicText counts completed redirects from zero and stops at two.
        redirects: 0,
        headers: { accept: "text/html" },
      }));
    } catch (error) {
      if (error instanceof UnsafePublicTarget)
        throw new HttpError(400, "请输入公开的 HTTPS 网站地址");
      throw new HttpError(502, "无法获取该网站的信息，请手动填写");
    }
    return parseMetadata(text);
  }
}
