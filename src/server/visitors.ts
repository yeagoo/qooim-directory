import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { HttpError, Operators, type Operator } from "./operators.js";
import { prefix, type AuthInstance } from "./auth.js";

const siteId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const listInput = z.strictObject({
  site: siteId,
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const PAGE = 50;

// Reader (visitor) accounts of a site: list, ban/unban and anonymize. Accounts live
// in the site's identity space; a legacy shared space spans several sites, so
// changing an account there is limited to global administrators.
export class Visitors {
  private operators: Operators;
  constructor(private pool: Pool) {
    this.operators = new Operators(pool);
  }
  async list(actor: Operator, input: unknown) {
    const value = listInput.parse(input);
    await this.operators.require(actor, value.site);
    const { rows } = await this.pool.query(
      `SELECT u.id,u.email,u.banned,m.role,
              (SELECT count(*)::int FROM favorite f WHERE f.site_id=m.site_id AND f.user_id=u.id) AS favorites,
              (SELECT count(*)::int FROM submission s WHERE s.site_id=m.site_id AND s.user_id=u.id) AS submissions,
              (SELECT max(ss.expires_at) FROM identity_session ss WHERE ss.site_id=m.site_id AND ss.user_id=u.id) AS last_session_expires
         FROM identity_member m JOIN identity_user u ON (u.id,u.space_id)=(m.user_id,m.space_id)
        WHERE m.site_id=$1 AND ($2='' OR position(lower($2) IN u.email)>0)
        ORDER BY u.email LIMIT $3 OFFSET $4`,
      [value.site, value.q, PAGE + 1, (value.page - 1) * PAGE],
    );
    return { visitors: rows.slice(0, PAGE), more: rows.length > PAGE, page: value.page };
  }
  async ban(actor: Operator, site: string, userId: string, banned: boolean) {
    siteId.parse(site);
    z.uuid().parse(userId);
    return transaction(this.pool, async (c) => {
      const member = await this.member(c, actor, site, userId);
      await c.query("UPDATE identity_user SET banned=$3 WHERE id=$1 AND space_id=$2", [
        userId,
        member.space_id,
        banned,
      ]);
      // Banned accounts already fail every session check; revoking also ends the
      // canonical sessions and removes the local ones.
      if (banned) await this.endSessions(c, member, userId);
      await this.audit(c, actor, site, banned ? "visitor.ban" : "visitor.unban", { userId });
      return { userId, banned };
    });
  }
  // Removes personal data: the email becomes a placeholder, the name and image are
  // cleared, sign-in methods and sessions are deleted and the account is banned.
  // Favorites and submissions stay, attached to the anonymous account.
  async anonymize(actor: Operator, site: string, userId: string) {
    siteId.parse(site);
    z.uuid().parse(userId);
    return transaction(this.pool, async (c) => {
      const member = await this.member(c, actor, site, userId);
      const email = `anonymized-${userId}@anonymized.invalid`;
      await c.query("UPDATE identity_user SET email=$3,banned=true WHERE id=$1 AND space_id=$2", [
        userId,
        member.space_id,
        email,
      ]);
      await this.endSessions(c, member, userId);
      // Every Better Auth user row of this person: the account's own instance (the
      // center for a legacy shared space) and any satellite instance it signed in to.
      for (const { instance, users } of await this.localUsers(c, member.space_id, userId)) {
        const table = prefix({ id: instance } as AuthInstance);
        const emails = (
          await c.query(`SELECT email FROM ${table}user WHERE id=ANY($1)`, [users])
        ).rows.map((row) => row.email as string);
        await c.query(
          `UPDATE ${table}user SET email='anonymized-'||id||'@anonymized.invalid',name='已注销用户',image=NULL WHERE id=ANY($1)`,
          [users],
        );
        await c.query(`DELETE FROM ${table}session WHERE "userId"=ANY($1)`, [users]);
        await c.query(`DELETE FROM ${table}account WHERE "userId"=ANY($1)`, [users]);
        if ((await c.query("SELECT to_regclass($1) AS t", [table + "passkey"])).rows[0].t)
          await c.query(`DELETE FROM ${table}passkey WHERE "userId"=ANY($1)`, [users]);
        if (emails.length)
          await c.query(`DELETE FROM ${table}verification WHERE identifier=ANY($1)`, [emails]);
      }
      await this.audit(c, actor, site, "visitor.anonymize", { userId });
      return { userId, anonymized: true };
    });
  }
  private async member(c: PoolClient, actor: Operator, site: string, userId: string) {
    await this.operators.require(actor, site, true, c);
    const member = (
      await c.query(
        `SELECT m.space_id,(SELECT count(*)::int FROM identity_site i WHERE i.space_id=m.space_id) AS sites
           FROM identity_member m WHERE m.site_id=$1 AND m.user_id=$2 FOR UPDATE`,
        [site, userId],
      )
    ).rows[0];
    if (!member) throw new HttpError(404, "访客账号不存在");
    if (member.sites > 1) await this.operators.require(actor, undefined, false, c);
    await c.query("SELECT 1 FROM identity_user WHERE id=$1 FOR UPDATE", [userId]);
    return member as { space_id: string };
  }
  private async endSessions(c: PoolClient, member: { space_id: string }, userId: string) {
    const bridges = (
      await c.query(
        `UPDATE identity_session ss SET revoked=true FROM session_bridge b
          WHERE ss.user_id=$1 AND ss.space_id=$2 AND b.canonical_session=ss.id
          RETURNING b.instance_id,b.local_session`,
        [userId, member.space_id],
      )
    ).rows;
    await c.query(
      "UPDATE identity_session SET revoked=true WHERE user_id=$1 AND space_id=$2",
      [userId, member.space_id],
    );
    for (const bridge of bridges)
      await c.query(`DELETE FROM ${prefix({ id: String(bridge.instance_id) } as AuthInstance)}session WHERE id=$1`, [
        bridge.local_session,
      ]);
  }
  // Local (Better Auth) user ids per auth instance: identity subjects of the space's
  // own instance, plus the satellite users recorded on this person's session bridges.
  private async localUsers(c: PoolClient, space: string, userId: string) {
    const { rows } = await c.query(
      `SELECT a.id::text AS instance,array_agg(DISTINCT sub.subject) AS users
         FROM identity_subject sub JOIN auth_instance a ON sub.issuer=a.origin||'/api/auth'
        WHERE sub.space_id=$1 AND sub.user_id=$2 AND a.state='ready'
        GROUP BY a.id
       UNION
       SELECT b.instance_id::text,array_agg(DISTINCT b.local_user)
         FROM session_bridge b JOIN identity_session ss ON ss.id=b.canonical_session
         JOIN auth_instance a ON a.id=b.instance_id
        WHERE ss.space_id=$1 AND ss.user_id=$2 AND a.state='ready'
        GROUP BY b.instance_id`,
      [space, userId],
    );
    const merged = new Map<string, Set<string>>();
    for (const row of rows)
      for (const user of row.users as string[])
        merged.set(row.instance, (merged.get(row.instance) ?? new Set()).add(user));
    return [...merged].map(([instance, users]) => ({ instance, users: [...users] }));
  }
  private async audit(c: PoolClient, actor: Operator, site: string, action: string, detail: unknown) {
    await c.query(
      "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,$3,$4)",
      [actor.id, site, action, detail],
    );
  }
}
export async function visitorsHttp(
  visitors: Visitors,
  actor: Operator,
  action: string,
  request: Request,
  body: () => Promise<unknown>,
) {
  if (action === "/visitors" && request.method === "GET")
    return Response.json(
      await visitors.list(actor, Object.fromEntries(new URL(request.url).searchParams)),
    );
  const match = action.match(
    /^\/visitors\/([a-z][a-z0-9-]{0,47})\/([0-9a-f-]{36})\/(ban|anonymize)$/,
  );
  if (!match || request.method !== "POST") return null;
  const [, site, userId, operation] = match;
  if (operation === "ban") {
    const { banned } = z.strictObject({ banned: z.boolean() }).parse(await body());
    return Response.json(await visitors.ban(actor, site, userId, banned));
  }
  z.strictObject({}).parse(await body());
  return Response.json(await visitors.anonymize(actor, site, userId));
}
