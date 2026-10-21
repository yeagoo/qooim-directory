import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import type { Operator } from "./operators.js";
import { HttpError, Operators } from "./operators.js";

const MAX_BYTES = 10 * 1024 * 1024,
  MAX_SIDE = 12000,
  MAX_PIXELS = 40_000_000;
const mimeExtension = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
type Mime = keyof typeof mimeExtension;
const uploadSchema = z.strictObject({
  site: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  filename: z.string().trim().min(1).max(255),
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  alt: z.string().trim().min(1).max(200),
  data: z.string().min(1),
});

function u24(b: Buffer, offset: number) {
  return b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16);
}
function dimensions(data: Buffer): { mime: Mime; width: number; height: number } | null {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return {
      mime: "image/png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    for (let i = 2; i + 9 < data.length; ) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = data.readUInt16BE(i + 2);
      if (length < 2 || i + 2 + length > data.length) return null;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      )
        return {
          mime: "image/jpeg",
          height: data.readUInt16BE(i + 5),
          width: data.readUInt16BE(i + 7),
        };
      i += 2 + length;
    }
    return null;
  }
  if (
    data.length >= 30 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X" && data.length >= 30)
      return { mime: "image/webp", width: u24(data, 24) + 1, height: u24(data, 27) + 1 };
    if (chunk === "VP8L" && data.length >= 25) {
      const b = data.readUInt32LE(21);
      return { mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && data.length >= 30) {
      const start = data.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
      if (start < 0 || start + 7 > data.length) return null;
      return {
        mime: "image/webp",
        width: data.readUInt16LE(start + 3) & 0x3fff,
        height: data.readUInt16LE(start + 5) & 0x3fff,
      };
    }
  }
  return null;
}
function decodeBase64(value: string) {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new HttpError(400, "图片内容不是合法 base64");
  const data = Buffer.from(value, "base64");
  if (!data.length || data.length > MAX_BYTES)
    throw new HttpError(413, "图片必须在 10 MiB 以内");
  return data;
}
export class Media {
  private readonly root: string;
  private readonly operators: Operators;
  constructor(
    private pool: Pool,
    root: string,
  ) {
    this.root = resolve(root);
    this.operators = new Operators(pool);
  }
  private path(site: string, sha: string, mime: Mime) {
    return join(this.root, site, `${sha}.${mimeExtension[mime]}`);
  }
  async upload(actor: Operator, input: unknown) {
    const value = uploadSchema.parse(input);
    await this.operators.require(actor, value.site, true);
    const data = decodeBase64(value.data);
    const info = dimensions(data);
    if (!info) throw new HttpError(415, "仅支持 JPEG、PNG 或 WebP 图片");
    if (info.mime !== value.mime)
      throw new HttpError(415, "图片类型与文件内容不一致");
    if (
      info.width < 1 ||
      info.height < 1 ||
      info.width > MAX_SIDE ||
      info.height > MAX_SIDE ||
      info.width * info.height > MAX_PIXELS
    )
      throw new HttpError(400, "图片尺寸过大");
    const sha = createHash("sha256").update(data).digest("hex"),
      target = this.path(value.site, sha, info.mime),
      temporary = join(this.root, value.site, `.tmp-${randomUUID()}`);
    await mkdir(join(this.root, value.site), { recursive: true, mode: 0o700 });
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    const { rows } = await this.pool.query(
      `INSERT INTO media(site_id,filename,mime,bytes,width,height,sha256,alt,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(site_id,sha256) DO NOTHING
       RETURNING id,site_id,filename,mime,bytes,width,height,sha256,alt,created_at`,
      [value.site, value.filename, info.mime, data.length, info.width, info.height, sha, value.alt, actor.id],
    );
    const row =
      rows[0] ??
      (
        await this.pool.query(
          "SELECT id,site_id,filename,mime,bytes,width,height,sha256,alt,created_at FROM media WHERE site_id=$1 AND sha256=$2",
          [value.site, sha],
        )
      ).rows[0];
    return this.dto(row);
  }
  async list(actor: Operator, site: string) {
    await this.operators.require(actor, site, false);
    const { rows } = await this.pool.query(
      "SELECT id,site_id,filename,mime,bytes,width,height,sha256,alt,created_at FROM media WHERE site_id=$1 ORDER BY created_at DESC,id LIMIT 200",
      [site],
    );
    return rows.map((row) => this.dto(row));
  }
  async get(actor: Operator, id: string) {
    const row = await this.row(id);
    await this.operators.require(actor, row.site_id, false);
    return this.dto(row);
  }
  async remove(actor: Operator, id: string) {
    const row = await this.row(id);
    await this.operators.require(actor, row.site_id, true);
    await this.pool.query("DELETE FROM media WHERE id=$1", [id]);
    await rm(this.path(row.site_id, row.sha256, row.mime), { force: true });
  }
  async adminFile(actor: Operator, id: string) {
    const row = await this.row(id);
    await this.operators.require(actor, row.site_id, false);
    return { row, data: await this.read(row) };
  }
  async publicFile(id: string) {
    const row = await this.row(id);
    return { row, data: await this.read(row) };
  }
  private async row(id: string) {
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, "媒体不存在");
    const { rows } = await this.pool.query(
      "SELECT id,site_id,filename,mime,bytes,width,height,sha256,alt,created_at FROM media WHERE id=$1",
      [id],
    );
    if (!rows[0]) throw new HttpError(404, "媒体不存在");
    return rows[0] as {
      id: string;
      site_id: string;
      filename: string;
      mime: Mime;
      bytes: number;
      width: number;
      height: number;
      sha256: string;
      alt: string;
      created_at: string;
    };
  }
  private async read(row: { site_id: string; sha256: string; mime: Mime }) {
    try {
      return await readFile(this.path(row.site_id, row.sha256, row.mime));
    } catch {
      throw new HttpError(404, "媒体不存在");
    }
  }
  private dto(row: Record<string, unknown>): {
    id: string;
    siteId: string;
    filename: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
    alt: string;
    createdAt: string;
    url: string;
    adminUrl: string;
  } {
    const id = String(row.id);
    return {
      id,
      siteId: String(row.site_id),
      filename: String(row.filename),
      mime: String(row.mime),
      bytes: Number(row.bytes),
      width: Number(row.width),
      height: Number(row.height),
      sha256: String(row.sha256),
      alt: String(row.alt),
      createdAt: String(row.created_at),
      url: `/media/${id}`,
      adminUrl: `/admin/api/media/${id}/file`,
    };
  }
}
