import { z } from "zod";
import type { Pool } from "pg";
import { transaction } from "../domain/transaction.js";
import { HttpError } from "./operators.js";
import {
  identifier,
  submissionInput,
  SUBMISSION_IMAGE_BYTES,
  SUBMISSION_IMAGE_SIDE,
  SUBMISSION_IMAGE_SITE_BYTES,
} from "./content.js";
import { inspectImage } from "./media.js";
export type Visitor = { id: string; user_id: string };
export class Personal {
  constructor(private pool: Pool) {}
  private async identity(
    c: import("pg").PoolClient,
    site: string,
    user: Visitor,
  ) {
    // Lock users before sessions so banning a user and revoking their
    // sessions can follow the same order without a lock cycle.
    const account = await c.query(
      "SELECT id FROM identity_user WHERE id=$1 AND NOT banned FOR SHARE",
      [user.user_id],
    );
    if (!account.rowCount) throw new HttpError(401, "请重新登录");
    const row = (
      await c.query(
        "SELECT space_id FROM identity_session WHERE id=$1 AND user_id=$2 AND site_id=$3 AND NOT revoked FOR SHARE",
        [user.id, user.user_id, site],
      )
    ).rows[0];
    // Hold session/user authority through commit. Evaluate deadlines after
    // acquiring those locks: transaction now() predates any lock wait.
    const valid =
      row &&
      (
        await c.query(
          "SELECT 1 FROM identity_session WHERE id=$1 AND expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()",
          [user.id],
        )
      ).rowCount;
    if (!valid) throw new HttpError(401, "请重新登录");
    return row;
  }
  async favorite(
    site: string,
    user: Visitor,
    resource: string,
    enabled: boolean,
  ) {
    identifier.parse(resource);
    return transaction(this.pool, async (c) => {
      const identity = await this.identity(c, site, user);
      if (enabled) {
        const row = (
          await c.query(
            "SELECT 1 FROM public_listing WHERE site_id=$1 AND resource_id=$2",
            [site, resource],
          )
        ).rows[0];
        if (!row) throw new HttpError(404, "本站资源不可收藏");
        await c.query(
          "INSERT INTO favorite VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [site, identity.space_id, user.user_id, resource],
        );
      } else
        await c.query(
          "DELETE FROM favorite WHERE site_id=$1 AND user_id=$2 AND resource_id=$3",
          [site, user.user_id, resource],
        );
      return { ok: true };
    });
  }
  async submit(site: string, user: Visitor, input: unknown) {
    const { image, ...value } = submissionInput.parse(input);
    const picture = image
      ? inspectImage(image, SUBMISSION_IMAGE_BYTES, SUBMISSION_IMAGE_SIDE)
      : null;
    return transaction(this.pool, async (c) => {
      // Wait for the business lock before retaining identity locks so logout
      // and bans can finish while a submission is queued.
      if (picture)
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "submission-image:" + site,
        ]);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "submission:" + site + ":" + user.user_id,
      ]);
      const identity = await this.identity(c, site, user);
      const valid = (
        await c.query(
          "SELECT 1 FROM site WHERE id=$1 AND active AND config->'locales' ? $2 AND 'directory'=ANY(modules)",
          [site, value.locale],
        )
      ).rowCount;
      if (!valid) throw new HttpError(400, "本站未启用该语言或导航模块");
      const recent = (
        await c.query(
          // Sample one cutoff after query lock waits, rather than using
          // transaction start time or advancing the cutoff for each row.
          `WITH cutoff AS MATERIALIZED (SELECT clock_timestamp()-interval '1 hour' AS at)
           SELECT count(*)::int AS n FROM submission
           WHERE site_id=$1 AND user_id=$2 AND created_at>(SELECT at FROM cutoff)`,
          [site, user.user_id],
        )
      ).rows[0].n;
      if (recent >= 10)
        throw new HttpError(429, "每小时最多提交 10 条，请稍后再试");
      if (picture) {
        const used = Number(
          (
            await c.query(
              `SELECT coalesce(sum(i.bytes),0)::bigint AS bytes
               FROM submission_image i JOIN submission s ON s.id=i.submission_id
               WHERE s.site_id=$1 AND s.status='pending'`,
              [site],
            )
          ).rows[0].bytes,
        );
        if (used + picture.data.length > SUBMISSION_IMAGE_SITE_BYTES)
          throw new HttpError(
            413,
            `本站待审核投稿图片总量已达上限（${SUBMISSION_IMAGE_SITE_BYTES / 1024 / 1024} MiB），请等待现有投稿审核后再试`,
          );
      }
      const created = (
        await c.query(
          "INSERT INTO submission(site_id,space_id,user_id,data,created_at) VALUES($1,$2,$3,$4,clock_timestamp()) RETURNING id,status",
          [site, identity.space_id, user.user_id, value],
        )
      ).rows[0];
      if (picture)
        await c.query(
          "INSERT INTO submission_image(submission_id,mime,bytes,width,height,sha256,data) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            created.id,
            picture.info.mime,
            picture.data.length,
            picture.info.width,
            picture.info.height,
            picture.sha,
            picture.data,
          ],
        );
      return created;
    });
  }
  async submissions(site: string, user: Visitor, page: unknown = 1) {
    const pageNumber = z.coerce.number().int().min(1).max(100000).parse(page);
    return (
      await this.pool.query(
        "SELECT id,data,status,note,created_at,EXISTS(SELECT 1 FROM submission_image i WHERE i.submission_id=submission.id) AS has_image FROM submission WHERE site_id=$1 AND user_id=$2 ORDER BY created_at DESC,id LIMIT 100 OFFSET $3",
        [site, user.user_id, (pageNumber - 1) * 100],
      )
    ).rows;
  }
}
