import { transaction } from "./transaction.js";
import type { Pool } from "pg";
import { z } from "zod";
export class IdentityConflict extends Error {}
export class IdentityStore {
  constructor(private pool: Pool) {}
  // Internal boundary: caller MUST verify issuer, audience, nonce and subject before invoking.
  // Email is a contact attribute, never authority to link an existing identity.
  async provisionVerifiedSubject(input: {
    siteId: string;
    issuer: string;
    subject: string;
    email: string;
  }) {
    const value = z
      .object({
        siteId: z.string().min(1),
        issuer: z.url(),
        subject: z.string().min(1).max(512),
        email: z.email(),
      })
      .parse(input);
    return transaction(this.pool, async (client) => {
      const site = await client.query(
        `SELECT i.space_id FROM identity_site i JOIN identity_space sp ON sp.id=i.space_id
    JOIN site s ON s.id=i.site_id WHERE i.site_id=$1 AND s.active FOR UPDATE OF sp,i,s`,
        [value.siteId],
      );
      if (!site.rows.length) throw new IdentityConflict("Site unavailable");
      const space = site.rows[0].space_id;
      let user = (
        await client.query(
          `SELECT u.id,u.banned FROM identity_subject sub JOIN identity_user u
    ON (u.id,u.space_id)=(sub.user_id,sub.space_id) WHERE sub.space_id=$1 AND sub.issuer=$2 AND sub.subject=$3`,
          [space, value.issuer, value.subject],
        )
      ).rows[0];
      if (!user) {
        const created = await client.query(
          `INSERT INTO identity_user(space_id,email) VALUES($1,$2)
     ON CONFLICT(space_id,email) DO NOTHING RETURNING id,banned`,
          [space, value.email.trim().toLowerCase()],
        );
        user = created.rows[0];
        if (!user)
          throw new IdentityConflict("Explicit account linking required");
        await client.query("INSERT INTO identity_subject VALUES($1,$2,$3,$4)", [
          space,
          value.issuer,
          value.subject,
          user.id,
        ]);
      }
      if (user.banned) throw new IdentityConflict("Identity unavailable");
      await client.query(
        `INSERT INTO identity_member(site_id,space_id,user_id,role) VALUES($1,$2,$3,'reader')
    ON CONFLICT(site_id,user_id) DO NOTHING`,
        [value.siteId, space, user.id],
      );
      return { userId: user.id as string, spaceId: space as string };
    });
  }
  async authorize(sessionId: string, siteId: string, role = "reader") {
    const { rows } = await this.pool.query(
      `SELECT u.id FROM identity_session ss
   JOIN identity_user u ON (u.id,u.space_id)=(ss.user_id,ss.space_id)
   JOIN identity_member m ON (m.site_id,m.user_id,m.space_id)=(ss.site_id,ss.user_id,ss.space_id)
   JOIN site s ON s.id=ss.site_id
   WHERE ss.id=$1 AND ss.site_id=$2 AND ss.expires_at>now() AND ss.absolute_expires_at>now() AND NOT ss.revoked AND NOT u.banned
   AND s.active AND m.role=$3`,
      [sessionId, siteId, role],
    );
    return rows.length === 1;
  }
  async revokeGroup(sessionId: string, siteId: string) {
    // Single statement ties revocation to an existing unexpired, unrevoked source session.
    return this.pool.query(
      `UPDATE identity_session target SET revoked=true FROM identity_session source
   WHERE source.id=$1 AND source.site_id=$2 AND NOT source.revoked AND source.expires_at>now() AND source.absolute_expires_at>now()
   AND target.space_id=source.space_id AND target.user_id=source.user_id AND target.center_session=source.center_session`,
      [sessionId, siteId],
    );
  }
  async switchEmptySite(siteId: string, targetSpace: string) {
    return transaction(this.pool, async (client) => {
      // Same lock ordering as provisioning: spaces before site membership and site.
      await client.query(
        "SELECT id FROM identity_space ORDER BY id FOR UPDATE",
      );
      const site = await client.query(
        "SELECT space_id FROM identity_site WHERE site_id=$1 FOR UPDATE",
        [siteId],
      );
      if (
        !site.rows[0] ||
        !(
          await client.query("SELECT id FROM identity_space WHERE id=$1", [
            targetSpace,
          ])
        ).rowCount
      )
        throw new IdentityConflict("Unknown site or space");
      if (site.rows[0].space_id === targetSpace) {
        return;
      }
      const affected = (
        await client.query(
          `SELECT
    (SELECT count(*)::int FROM identity_member WHERE site_id=$1) AS members,
    (SELECT count(*)::int FROM identity_session WHERE site_id=$1) AS sessions,
    (SELECT count(*)::int FROM favorite WHERE site_id=$1) AS favorites,
    (SELECT count(*)::int FROM identity_space WHERE center_site=$1) AS centers`,
          [siteId],
        )
      ).rows[0];
      if (Object.values(affected).some((count) => Number(count) > 0))
        throw new IdentityConflict(
          "Site cannot change account space: " + JSON.stringify(affected),
        );
      await client.query(
        "UPDATE identity_site SET space_id=$2 WHERE site_id=$1",
        [siteId, targetSpace],
      );
    });
  }
  async migrationConflicts(sourceSpace: string, targetSpace: string) {
    const { rows } = await this.pool.query(
      `SELECT a.id AS source,b.id AS target,a.email
   FROM identity_user a JOIN identity_user b ON a.email=b.email
   WHERE a.space_id=$1 AND b.space_id=$2 ORDER BY a.email`,
      [sourceSpace, targetSpace],
    );
    return rows;
  }
}
