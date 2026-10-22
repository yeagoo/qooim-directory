import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { siteLimits } from "./limits.js";
import type { Operator } from "./operators.js";
import { HttpError, Operators } from "./operators.js";
import type { RetentionPolicy } from "./retention.js";

const MAX_BYTES = 10 * 1024 * 1024,
  MAX_SIDE = 12000,
  MAX_PIXELS = 40_000_000;
const mimeExtension = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
type Mime = keyof typeof mimeExtension;
const sitePattern = /^[a-z][a-z0-9-]{0,47}$/;
const storedPattern = /^([a-f0-9]{64})\.(jpg|png|webp)$/;
const extensionMime: Record<string, Mime> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
// One orphan-cleanup run inspects at most this many directory entries and media rows.
const CLEANUP_MAX_FILES = 10_000,
  CLEANUP_LOCK_BATCH = 200;
const COLUMNS =
  "id,site_id,filename,mime,bytes,width,height,sha256,alt,created_at";
function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3} GiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const uploadSchema = z.strictObject({
  site: z.string().regex(sitePattern),
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
      target = this.path(value.site, sha, info.mime);
    await mkdir(join(this.root, value.site), { recursive: true, mode: 0o700 });
    // Quota check, file placement and insert are serialized per site; orphan cleanup
    // takes the same lock before deciding a file is unreferenced.
    const row = await this.locked(value.site, async (client) => {
      const existing = (
        await client.query(
          `SELECT ${COLUMNS} FROM media WHERE site_id=$1 AND sha256=$2`,
          [value.site, sha],
        )
      ).rows[0];
      if (existing) {
        // Identical content is already stored: reuse it without consuming quota,
        // restoring the file if it went missing.
        if (!(await this.regularFile(target)))
          await this.place(value.site, target, data);
        return existing;
      }
      const usage = await this.usageOf(client, value.site);
      const limits = await siteLimits(client, value.site);
      if (usage.files + 1 > limits.mediaFiles)
        throw new HttpError(
          413,
          `媒体文件数量已达上限：本站最多 ${limits.mediaFiles} 个文件，已有 ${usage.files} 个`,
        );
      if (usage.bytes + data.length > limits.mediaBytes)
        throw new HttpError(
          413,
          `媒体存储空间不足：本站上限 ${formatBytes(limits.mediaBytes)}，已用 ${formatBytes(usage.bytes)}，本次图片 ${formatBytes(data.length)}`,
        );
      await this.place(value.site, target, data);
      await client.query("SAVEPOINT media_insert");
      try {
        return (
          await client.query(
            `INSERT INTO media(site_id,filename,mime,bytes,width,height,sha256,alt,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING ${COLUMNS}`,
            [value.site, value.filename, info.mime, data.length, info.width, info.height, sha, value.alt, actor.id],
          )
        ).rows[0];
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT media_insert");
        const referenced = (
          await client.query(
            "SELECT 1 FROM media WHERE site_id=$1 AND sha256=$2 AND mime=$3",
            [value.site, sha, info.mime],
          )
        ).rowCount;
        if (!referenced) await rm(target, { force: true });
        throw error;
      }
    });
    return this.dto(row);
  }
  async usage(actor: Operator, site: string) {
    await this.operators.require(actor, site, false);
    const usage = await this.usageOf(this.pool, site);
    const limits = await siteLimits(this.pool, site);
    return {
      site,
      bytes: usage.bytes,
      files: usage.files,
      limitBytes: limits.mediaBytes,
      limitFiles: limits.mediaFiles,
    };
  }
  async list(actor: Operator, site: string) {
    await this.operators.require(actor, site, false);
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM media WHERE site_id=$1 ORDER BY created_at DESC,id LIMIT 200`,
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
    // Under the upload lock so a concurrent re-upload of the same image keeps its file.
    await this.locked(row.site_id, async (client) => {
      const deleted = (
        await client.query("DELETE FROM media WHERE id=$1", [id])
      ).rowCount;
      if (deleted) await rm(this.path(row.site_id, row.sha256, row.mime), { force: true });
    });
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
  // Removes stale temporary files and stored images without a matching media row.
  // Never follows symlinks, never touches unknown names and never deletes rows.
  async cleanupOrphans(policy: RetentionPolicy): Promise<Record<string, number>> {
    const result = {
      scanned: 0,
      removedTemp: 0,
      removedOrphans: 0,
      missingFiles: 0,
      skipped: 0,
    };
    const cutoff = Date.now() - policy.mediaOrphanGraceMinutes * 60_000;
    let sites: string[];
    try {
      sites = (await readdir(this.root)).filter((name) => sitePattern.test(name)).sort();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      sites = [];
    }
    for (const site of sites) {
      if (result.scanned >= CLEANUP_MAX_FILES) break;
      const directory = join(this.root, site);
      const stat = await lstat(directory).catch(() => null);
      if (!stat?.isDirectory()) {
        result.skipped++;
        continue;
      }
      const candidates: { name: string; sha: string; mime: Mime }[] = [];
      const handle = await opendir(directory);
      try {
        for await (const entry of handle) {
          if (result.scanned >= CLEANUP_MAX_FILES) break;
          result.scanned++;
          const file = await lstat(join(directory, entry.name)).catch(() => null);
          if (!file?.isFile()) {
            result.skipped++;
            continue;
          }
          if (entry.name.startsWith(".tmp-")) {
            if (file.mtimeMs < cutoff && (await this.unlinkOld(join(directory, entry.name), cutoff)))
              result.removedTemp++;
            continue;
          }
          const match = entry.name.match(storedPattern);
          if (!match) {
            result.skipped++;
            continue;
          }
          if (file.mtimeMs < cutoff)
            candidates.push({ name: entry.name, sha: match[1]!, mime: extensionMime[match[2]!]! });
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      for (let i = 0; i < candidates.length; i += CLEANUP_LOCK_BATCH) {
        const batch = candidates.slice(i, i + CLEANUP_LOCK_BATCH);
        result.removedOrphans += await this.locked(site, async (client) => {
          const referenced = new Set(
            (
              await client.query(
                "SELECT sha256,mime FROM media WHERE site_id=$1 AND sha256=ANY($2::text[])",
                [site, batch.map((item) => item.sha)],
              )
            ).rows.map((row) => `${row.sha256}:${row.mime}`),
          );
          let removed = 0;
          for (const item of batch)
            if (
              !referenced.has(`${item.sha}:${item.mime}`) &&
              (await this.unlinkOld(join(directory, item.name), cutoff))
            )
              removed++;
          return removed;
        });
      }
    }
    // Report rows whose file is gone; rows are kept so references stay auditable.
    const { rows } = await this.pool.query(
      "SELECT site_id,sha256,mime FROM media ORDER BY site_id,sha256 LIMIT $1",
      [CLEANUP_MAX_FILES],
    );
    for (const row of rows)
      if (!(await this.regularFile(this.path(row.site_id, row.sha256, row.mime))))
        result.missingFiles++;
    return result;
  }
  private locked<T>(site: string, work: (client: PoolClient) => Promise<T>) {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('media:'||$1))", [site]);
      return work(client);
    });
  }
  private async usageOf(executor: Pool | PoolClient, site: string) {
    const row = (
      await executor.query(
        "SELECT count(*)::int AS files,coalesce(sum(bytes),0)::bigint AS bytes FROM media WHERE site_id=$1",
        [site],
      )
    ).rows[0];
    return { files: Number(row.files), bytes: Number(row.bytes) };
  }
  // Writes to a private temporary name first so readers never see a partial image.
  private async place(site: string, target: string, data: Buffer) {
    const temporary = join(this.root, site, `.tmp-${randomUUID()}`);
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  private async regularFile(path: string) {
    try {
      return (await lstat(path)).isFile();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }
  // Re-checks just before unlinking: the entry must still be an old regular file.
  private async unlinkOld(path: string, cutoff: number) {
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.mtimeMs >= cutoff) return false;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
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

