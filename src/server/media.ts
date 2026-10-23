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
  "id,site_id,filename,mime,bytes,width,height,sha256,alt,created_at,version";
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

const replaceSchema = z.strictObject({
  filename: z.string().trim().min(1).max(255),
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  alt: z.string().trim().min(1).max(200).optional(),
  data: z.string().min(1),
});
type StoredFile = { sha256: string; mime: Mime };
// Files a locked mutation hands back for unlinking once its transaction has ended:
// `committed` after a successful commit, `failed` after a rollback (including a failed COMMIT).
type Release = { committed: StoredFile[]; failed: StoredFile[] };
type MediaRow = {
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
  version: number;
};

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
  // Shared upload/replace validation: trusts only magic bytes and parsed dimensions.
  private image(input: { mime: string; data: string }) {
    const data = decodeBase64(input.data);
    const info = dimensions(data);
    if (!info) throw new HttpError(415, "仅支持 JPEG、PNG 或 WebP 图片");
    if (info.mime !== input.mime)
      throw new HttpError(415, "图片类型与文件内容不一致");
    if (
      info.width < 1 ||
      info.height < 1 ||
      info.width > MAX_SIDE ||
      info.height > MAX_SIDE ||
      info.width * info.height > MAX_PIXELS
    )
      throw new HttpError(400, "图片尺寸过大");
    return { data, info, sha: createHash("sha256").update(data).digest("hex") };
  }
  private bytesError(limit: number, used: number, size: number) {
    return new HttpError(
      413,
      `媒体存储空间不足：本站上限 ${formatBytes(limit)}，已用 ${formatBytes(used)}，本次图片 ${formatBytes(size)}`,
    );
  }
  async upload(actor: Operator, input: unknown) {
    const value = uploadSchema.parse(input);
    await this.operators.require(actor, value.site, true);
    const { data, info, sha } = this.image(value);
    const target = this.path(value.site, sha, info.mime);
    await mkdir(join(this.root, value.site), { recursive: true, mode: 0o700 });
    // Quota check, file placement and insert are serialized per site; orphan cleanup
    // takes the same lock before deciding a file is unreferenced. The file is placed
    // before the row commits; if the transaction fails it is unlinked afterwards, unless
    // something references it by then.
    const row = await this.mutate(value.site, async (client, release) => {
      const existing = (
        await client.query(
          `SELECT ${COLUMNS} FROM media WHERE site_id=$1 AND sha256=$2 ORDER BY created_at,id LIMIT 1`,
          [value.site, sha],
        )
      ).rows[0];
      if (existing) {
        // Identical content is already some media's current version: reuse it without
        // consuming quota, restoring the file if it went missing.
        if (!(await this.regularFile(target))) {
          await this.place(value.site, target, data);
          release.failed.push({ sha256: sha, mime: info.mime });
        }
        return existing;
      }
      // Content kept only as a historical version still gets a new media row, but its
      // file is already stored and its bytes already counted.
      const stored = await this.referenced(client, value.site, sha, info.mime);
      const usage = await this.usageOf(client, value.site);
      const limits = await siteLimits(client, value.site);
      if (usage.files + 1 > limits.mediaFiles)
        throw new HttpError(
          413,
          `媒体文件数量已达上限：本站最多 ${limits.mediaFiles} 个文件，已有 ${usage.files} 个`,
        );
      if (!stored && usage.bytes + data.length > limits.mediaBytes)
        throw this.bytesError(limits.mediaBytes, usage.bytes, data.length);
      if (!stored || !(await this.regularFile(target))) {
        await this.place(value.site, target, data);
        release.failed.push({ sha256: sha, mime: info.mime });
      }
      const created = (
        await client.query(
          `INSERT INTO media(site_id,filename,mime,bytes,width,height,sha256,alt,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING ${COLUMNS}`,
          [value.site, value.filename, info.mime, data.length, info.width, info.height, sha, value.alt, actor.id],
        )
      ).rows[0];
      // media mirrors its current version; media_version keeps the history.
      await client.query(
        `INSERT INTO media_version(media_id,version,filename,mime,bytes,width,height,sha256,created_by)
         SELECT id,version,filename,mime,bytes,width,height,sha256,created_by FROM media WHERE id=$1`,
        [created.id],
      );
      // Only a newly created media is audited; a dedupe hit changes nothing.
      await this.audit(client, actor, value.site, "media.upload", {
        mediaId: created.id,
        sha256: sha,
        bytes: data.length,
        filename: value.filename,
      });
      return created;
    });
    return this.dto(row);
  }
  // Uploads new content as the next version of an existing media. Drafts follow the
  // current version at once; published content keeps its frozen version until republished.
  async replace(actor: Operator, id: string, input: unknown) {
    const current = await this.row(id);
    await this.operators.require(actor, current.site_id, true);
    const value = replaceSchema.parse(input);
    const { data, info, sha } = this.image(value);
    const site = current.site_id,
      target = this.path(site, sha, info.mime);
    await mkdir(join(this.root, site), { recursive: true, mode: 0o700 });
    const row = await this.mutate(site, async (client, release) => {
      const media = await this.lockRow(client, id);
      if (media.sha256 === sha)
        throw new HttpError(409, "新图片与当前版本内容相同，无需替换");
      // The file count is unchanged; bytes count only for content new to this site.
      const stored = await this.referenced(client, site, sha, info.mime);
      if (!stored) {
        const usage = await this.usageOf(client, site);
        const limits = await siteLimits(client, site);
        if (usage.bytes + data.length > limits.mediaBytes)
          throw this.bytesError(limits.mediaBytes, usage.bytes, data.length);
      }
      if (!stored || !(await this.regularFile(target))) {
        await this.place(site, target, data);
        release.failed.push({ sha256: sha, mime: info.mime });
      }
      const updated = await this.newVersion(client, actor, media, {
        filename: value.filename,
        mime: info.mime,
        bytes: data.length,
        width: info.width,
        height: info.height,
        sha256: sha,
        restoredFrom: null,
        alt: value.alt,
      });
      await this.audit(client, actor, site, "media.replace", {
        mediaId: id,
        version: updated.version,
        previousVersion: media.version,
        filename: value.filename,
        sha256: sha,
        bytes: data.length,
        ...(value.alt === undefined ? {} : { alt: value.alt }),
      });
      return updated;
    });
    return this.dto(row);
  }
  // Makes an old version current again by copying it as a new version; history is never rewritten.
  async restore(actor: Operator, id: string, version: number) {
    const current = await this.row(id);
    await this.operators.require(actor, current.site_id, true);
    const site = current.site_id;
    const row = await this.locked(site, async (client) => {
      const media = await this.lockRow(client, id);
      const source = (
        await client.query(
          "SELECT filename,mime,bytes,width,height,sha256 FROM media_version WHERE media_id=$1 AND version=$2",
          [id, version],
        )
      ).rows[0];
      if (!source) throw new HttpError(404, "媒体版本不存在");
      if (media.version === version)
        throw new HttpError(409, "该版本已是当前版本");
      if (!(await this.regularFile(this.path(site, source.sha256, source.mime))))
        throw new HttpError(409, "该版本的图片文件已丢失，无法设为当前版本");
      const updated = await this.newVersion(client, actor, media, {
        ...source,
        bytes: Number(source.bytes),
        restoredFrom: version,
      });
      await this.audit(client, actor, site, "media.restore", {
        mediaId: id,
        version: updated.version,
        previousVersion: media.version,
        restoredFrom: version,
        sha256: source.sha256,
      });
      return updated;
    });
    return this.dto(row);
  }
  // Deletes one non-current version. The caller pre-checks publications; the optional
  // guard re-checks under the media row lock so a concurrent publish cannot pin it
  // between that check and the delete. The stored file goes only when no other version
  // in the site uses it, and only after the deletion has committed.
  async removeVersion(
    actor: Operator,
    id: string,
    version: number,
    guard?: (client: PoolClient) => Promise<void>,
  ) {
    const current = await this.row(id);
    await this.operators.require(actor, current.site_id, true);
    const site = current.site_id;
    await this.mutate(site, async (client, release) => {
      const media = await this.lockRow(client, id);
      await guard?.(client);
      const target = (
        await client.query(
          "DELETE FROM media_version WHERE media_id=$1 AND version=$2 AND version<>$3 RETURNING sha256,mime",
          [id, version, media.version],
        )
      ).rows[0] as StoredFile | undefined;
      if (!target) {
        if (media.version === version) throw new HttpError(409, "不能删除当前版本");
        throw new HttpError(404, "媒体版本不存在");
      }
      // fileRemoved: the deletion left the file unreferenced, so it is unlinked after commit.
      const fileRemoved = !(await this.referenced(client, site, target.sha256, target.mime));
      if (fileRemoved) release.committed.push(target);
      await this.audit(client, actor, site, "media.version.delete", {
        mediaId: id,
        version,
        sha256: target.sha256,
        fileRemoved,
      });
    });
  }
  async versions(actor: Operator, id: string) {
    const current = await this.row(id);
    await this.operators.require(actor, current.site_id, false);
    const { rows } = await this.pool.query(
      `SELECT v.version,v.filename,v.mime,v.bytes,v.width,v.height,v.sha256,v.restored_from,v.created_at,o.email
       FROM media_version v LEFT JOIN operator_user o ON o.id=v.created_by
       WHERE v.media_id=$1 ORDER BY v.version DESC`,
      [id],
    );
    return {
      media: this.dto(current),
      versions: rows.map((row) => ({
        version: Number(row.version),
        filename: String(row.filename),
        mime: String(row.mime),
        bytes: Number(row.bytes),
        width: Number(row.width),
        height: Number(row.height),
        sha256: String(row.sha256),
        restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
        createdAt: String(row.created_at),
        createdBy: row.email === null ? null : String(row.email),
        current: Number(row.version) === current.version,
        adminUrl: `/admin/api/media/${id}/versions/${Number(row.version)}/file`,
      })),
    };
  }
  async versionFile(actor: Operator, id: string, version: number) {
    const current = await this.row(id);
    await this.operators.require(actor, current.site_id, false);
    const row = (
      await this.pool.query(
        "SELECT mime,sha256 FROM media_version WHERE media_id=$1 AND version=$2",
        [id, version],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "媒体版本不存在");
    const file = { site_id: current.site_id, sha256: String(row.sha256), mime: row.mime as Mime };
    return { row: file, data: await this.read(file) };
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
  async get(actor: Operator, id: string, write = false) {
    const row = await this.row(id);
    await this.operators.require(actor, row.site_id, write);
    return this.dto(row);
  }
  async remove(
    actor: Operator,
    id: string,
    guard?: (client: PoolClient) => Promise<void>,
  ) {
    const row = await this.row(id);
    await this.operators.require(actor, row.site_id, true);
    // Under the upload lock; files are shared between versions and media, so only those
    // left unreferenced by this deletion are handed back, and unlinked after commit.
    const site = row.site_id;
    await this.mutate(site, async (client, release) => {
      // FOR UPDATE serializes with material()'s FOR SHARE. Re-check references after the
      // lock: a concurrent stage/publish that committed before it may now use this media.
      await this.lockRow(client, id);
      await guard?.(client);
      const files = (
        await client.query(
          `SELECT sha256,mime FROM media WHERE id=$1
           UNION SELECT sha256,mime FROM media_version WHERE media_id=$1`,
          [id],
        )
      ).rows as StoredFile[];
      const versions = Number(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM media_version WHERE media_id=$1",
            [id],
          )
        ).rows[0].n,
      );
      const deleted = (
        await client.query("DELETE FROM media WHERE id=$1", [id])
      ).rowCount;
      if (!deleted) return;
      for (const file of files)
        if (!(await this.referenced(client, site, file.sha256, file.mime)))
          release.committed.push(file);
      // filesRemoved counts files this deletion left unreferenced; they are unlinked after
      // commit, and any the follow-up cannot remove are left to orphan cleanup.
      await this.audit(client, actor, site, "media.delete", {
        mediaId: id,
        versions,
        filesRemoved: release.committed.length,
      });
    });
  }
  async adminFile(actor: Operator, id: string) {
    const row = await this.row(id);
    await this.operators.require(actor, row.site_id, false);
    return { row, data: await this.read(row) };
  }
  // Reads one frozen version; the caller has already checked it is published.
  async publicFile(id: string, version: number) {
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, "媒体不存在");
    const row = (
      await this.pool.query(
        "SELECT m.site_id,v.version,v.mime,v.bytes,v.sha256 FROM media m JOIN media_version v ON v.media_id=m.id WHERE m.id=$1 AND v.version=$2",
        [id, version],
      )
    ).rows[0] as
      | { site_id: string; version: number; mime: Mime; bytes: number; sha256: string }
      | undefined;
    if (!row) throw new HttpError(404, "媒体不存在");
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
                `SELECT sha256,mime FROM media WHERE site_id=$1 AND sha256=ANY($2::text[])
                 UNION SELECT v.sha256,v.mime FROM media_version v JOIN media m ON m.id=v.media_id
                 WHERE m.site_id=$1 AND v.sha256=ANY($2::text[])`,
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
    // Report stored files (current or historical versions) that are gone; rows are kept
    // so references stay auditable.
    const { rows } = await this.pool.query(
      `SELECT site_id,sha256,mime FROM media
       UNION SELECT m.site_id,v.sha256,v.mime FROM media_version v JOIN media m ON m.id=v.media_id
       ORDER BY site_id,sha256 LIMIT $1`,
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
  // files = media rows; bytes = each distinct stored content once, across all versions.
  private async usageOf(executor: Pool | PoolClient, site: string) {
    const row = (
      await executor.query(
        `SELECT (SELECT count(*)::int FROM media WHERE site_id=$1) AS files,
                (SELECT coalesce(sum(bytes),0)::bigint FROM (
                   SELECT DISTINCT ON (sha256) sha256,bytes FROM (
                     SELECT sha256,bytes FROM media WHERE site_id=$1
                     UNION ALL SELECT v.sha256,v.bytes FROM media_version v JOIN media m ON m.id=v.media_id WHERE m.site_id=$1
                   ) a ORDER BY sha256
                 ) d) AS bytes`,
        [site],
      )
    ).rows[0];
    return { files: Number(row.files), bytes: Number(row.bytes) };
  }
  // A stored file is referenced while any media (current) or version row of the site uses it.
  private async referenced(client: PoolClient, site: string, sha: string, mime: string) {
    return Boolean(
      (
        await client.query(
          `SELECT 1 FROM media WHERE site_id=$1 AND sha256=$2 AND mime=$3
           UNION ALL SELECT 1 FROM media_version v JOIN media m ON m.id=v.media_id
           WHERE m.site_id=$1 AND v.sha256=$2 AND v.mime=$3 LIMIT 1`,
          [site, sha, mime],
        )
      ).rowCount,
    );
  }
  // Runs a locked mutation and unlinks files only once its transaction has ended, so a
  // failed COMMIT never leaves a row whose file is gone. `committed` files are unlinked
  // after a successful commit, `failed` ones (just placed) after a rollback.
  private async mutate<T>(
    site: string,
    work: (client: PoolClient, release: Release) => Promise<T>,
  ) {
    const release: Release = { committed: [], failed: [] };
    let result: T;
    try {
      result = await this.locked(site, (client) => work(client, release));
    } catch (error) {
      await this.sweep(site, release.failed);
      throw error;
    }
    await this.sweep(site, release.committed);
    return result;
  }
  // The site lock ended with the transaction, so a concurrent upload of the same content
  // may have committed a reference since. Re-take the lock, re-check each file and unlink
  // it while holding the lock. A file this step skips (process exit, database or file
  // system error) is only an unreferenced orphan, which cleanupOrphans removes after the
  // grace period, so failures here are logged and never surface to the caller: the
  // mutation itself has already committed or rolled back.
  private async sweep(site: string, files: StoredFile[]) {
    if (!files.length) return;
    try {
      await this.locked(site, async (client) => {
        for (const file of files)
          if (!(await this.referenced(client, site, file.sha256, file.mime)))
            await rm(this.path(site, file.sha256, file.mime), { force: true });
      });
    } catch {
      console.error("Media file removal deferred to orphan cleanup");
    }
  }
  private async lockRow(client: PoolClient, id: string) {
    const row = (
      await client.query(`SELECT ${COLUMNS} FROM media WHERE id=$1 FOR UPDATE`, [id])
    ).rows[0];
    if (!row) throw new HttpError(404, "媒体不存在");
    return { ...row, version: Number(row.version) } as MediaRow;
  }
  // Appends the next version and points the media row at it in the same transaction.
  private async newVersion(
    client: PoolClient,
    actor: Operator,
    media: MediaRow,
    file: {
      filename: string;
      mime: Mime;
      bytes: number;
      width: number;
      height: number;
      sha256: string;
      restoredFrom: number | null;
      alt?: string;
    },
  ) {
    const next =
      Number(
        (
          await client.query(
            "SELECT coalesce(max(version),0) AS v FROM media_version WHERE media_id=$1",
            [media.id],
          )
        ).rows[0].v,
      ) + 1;
    const version = Math.max(next, media.version + 1);
    await client.query(
      `INSERT INTO media_version(media_id,version,filename,mime,bytes,width,height,sha256,restored_from,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [media.id, version, file.filename, file.mime, file.bytes, file.width, file.height, file.sha256, file.restoredFrom, actor.id],
    );
    return (
      await client.query(
        `UPDATE media SET version=$2,filename=$3,mime=$4,bytes=$5,width=$6,height=$7,sha256=$8,alt=coalesce($9,alt)
         WHERE id=$1 RETURNING ${COLUMNS}`,
        [media.id, version, file.filename, file.mime, file.bytes, file.width, file.height, file.sha256, file.alt ?? null],
      )
    ).rows[0] as Record<string, unknown>;
  }
  private async audit(
    client: PoolClient,
    actor: Operator,
    site: string,
    action: string,
    detail: unknown,
  ) {
    await client.query(
      "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,$3,$4)",
      [actor.id, site, action, detail],
    );
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
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM media WHERE id=$1`, [id]);
    if (!rows[0]) throw new HttpError(404, "媒体不存在");
    return { ...rows[0], version: Number(rows[0].version) } as MediaRow;
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
    version: number;
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
      version: Number(row.version),
      // Public URL of the current version; it serves only once that version is published.
      url: `/media/${id}/${Number(row.version)}`,
      adminUrl: `/admin/api/media/${id}/file`,
    };
  }
}
