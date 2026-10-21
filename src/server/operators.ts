import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { digest, hashPassword, verifyPassword } from "./crypto.js";
import { transaction } from "../domain/transaction.js";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Operator = { id: string; email: string; global_admin: boolean };
export class Operators {
  constructor(private pool: Pool) {}
  async create(
    email: string,
    password: string,
    globalAdmin = false,
    actor?: Operator,
  ) {
    if (actor) await this.require(actor);
    email = z.email().parse(email.trim().toLowerCase());
    z.string().min(12).max(128).parse(password);
    const hash = await hashPassword(password);
    return transaction(this.pool, async (c) => {
      // Bootstrap has no actor. Interactive creation must recheck after hashing
      // and hold authority through insertion and audit commit.
      if (actor) await this.require(actor, undefined, false, c);
      const id = (
        await c.query(
          "INSERT INTO operator_user(email,password_hash,global_admin) VALUES($1,$2,$3) RETURNING id",
          [email, hash, globalAdmin],
        )
      ).rows[0].id as string;
      if (actor)
        await c.query(
          "INSERT INTO audit_event(actor_id,action,detail) VALUES($1,'operator.create',$2)",
          [actor.id, { userId: id }],
        );
      return id;
    });
  }
  async login(email: string, password: string, source = "untrusted") {
    z.string().max(254).parse(email);
    z.string().max(128).parse(password);
    email = email.toLowerCase().trim();
    const allowed = await this.pool.query(
      `INSERT INTO login_limit VALUES($1,1,now()+interval '5 minutes')
   ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limit.reset_at<now() THEN 1 ELSE login_limit.attempts+1 END,
   reset_at=CASE WHEN login_limit.reset_at<now() THEN now()+interval '5 minutes' ELSE login_limit.reset_at END RETURNING attempts`,
      [digest(email + "\n" + source)],
    );
    if (allowed.rows[0].attempts > 10)
      throw new HttpError(429, "登录尝试过多，请稍后再试");
    const user = (
      await this.pool.query("SELECT * FROM operator_user WHERE email=$1", [
        email,
      ])
    ).rows[0];
    const dummy = "00000000000000000000000000000000:" + "00".repeat(64);
    if (
      !(await verifyPassword(password, user?.password_hash ?? dummy)) ||
      !user ||
      user.disabled
    )
      throw new HttpError(401, "账号或密码不正确");
    await this.pool.query("DELETE FROM login_limit WHERE key=$1", [
      digest(email + "\n" + source),
    ]);
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      "INSERT INTO operator_session VALUES($1,$2,now()+interval '8 hours')",
      [digest(token), user.id],
    );
    return token;
  }
  async current(headers: Headers): Promise<Operator> {
    const token = headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("network_operator="))
      ?.slice(17);
    if (!token) throw new HttpError(401, "请先登录");
    const { rows } = await this.pool.query(
      `SELECT u.id,u.email,u.global_admin FROM operator_session ss JOIN operator_user u ON u.id=ss.user_id WHERE token_hash=$1 AND expires_at>now() AND NOT disabled`,
      [digest(token)],
    );
    if (!rows[0]) throw new HttpError(401, "会话已过期");
    return rows[0];
  }
  async logout(headers: Headers) {
    const token = headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("network_operator="))
      ?.slice(17);
    if (token)
      await this.pool.query(
        "DELETE FROM operator_session WHERE token_hash=$1",
        [digest(token)],
      );
  }
  async require(
    user: Operator,
    siteId?: string,
    write = false,
    client?: PoolClient,
  ) {
    // Re-read global role for every operation, including CLI/import service calls.
    // A write transaction holds the relevant authority rows until commit.
    const executor = client ?? this.pool;
    const live = (
      await executor.query(
        "SELECT global_admin FROM operator_user WHERE id=$1 AND NOT disabled" +
          (client ? " FOR SHARE" : ""),
        [user.id],
      )
    ).rows[0];
    if (live?.global_admin) return;
    if (live && siteId) {
      const { rows } = await executor.query(
        "SELECT role FROM operator_grant WHERE user_id=$1 AND site_id=$2" +
          (client ? " FOR SHARE" : ""),
        [user.id, siteId],
      );
      if (rows[0] && (!write || rows[0].role === "editor")) return;
    }
    throw new HttpError(403, "没有此操作的权限");
  }
  async setPassword(actor: Operator, userId: string, password: string) {
    z.uuid().parse(userId);
    z.string().min(12).max(128).parse(password);
    const hash = await hashPassword(password);
    await transaction(this.pool, async (c) => {
      await c.query(
        "SELECT id FROM operator_user WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
        [[actor.id, userId]],
      );
      await this.require(actor, undefined, false, c);
      const target = (
        await c.query("SELECT id FROM operator_user WHERE id=$1", [userId])
      ).rows[0];
      if (!target) throw new HttpError(404, "成员不存在");
      await c.query("UPDATE operator_user SET password_hash=$2 WHERE id=$1", [
        userId,
        hash,
      ]);
      await c.query("DELETE FROM operator_session WHERE user_id=$1", [userId]);
      await c.query(
        "INSERT INTO audit_event(actor_id,action,detail) VALUES($1,'operator.password',$2)",
        [actor.id, { userId }],
      );
    });
  }

  async setDisabled(actor: Operator, userId: string, disabled: boolean) {
    z.uuid().parse(userId);
    if (disabled && userId === actor.id)
      throw new HttpError(400, "不能停用自己的账号");
    await transaction(this.pool, async (c) => {
      await c.query(
        "SELECT id FROM operator_user WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
        [[actor.id, userId]],
      );
      await this.require(actor, undefined, false, c);
      const target = (
        await c.query(
          "SELECT id,global_admin,disabled FROM operator_user WHERE id=$1",
          [userId],
        )
      ).rows[0];
      if (!target) throw new HttpError(404, "成员不存在");
      if (disabled && target.global_admin && !target.disabled) {
        const remaining = (
          await c.query(
            "SELECT count(*)::int AS n FROM operator_user WHERE global_admin AND NOT disabled",
          )
        ).rows[0].n as number;
        if (remaining <= 1)
          throw new HttpError(400, "不能停用最后一个站群管理员");
      }
      await c.query("UPDATE operator_user SET disabled=$2 WHERE id=$1", [
        userId,
        disabled,
      ]);
      if (disabled)
        await c.query("DELETE FROM operator_session WHERE user_id=$1", [userId]);
      await c.query(
        "INSERT INTO audit_event(actor_id,action,detail) VALUES($1,$2,$3)",
        [actor.id, disabled ? "operator.disable" : "operator.enable", { userId }],
      );
    });
  }

  async revokeSessions(actor: Operator, userId: string) {
    z.uuid().parse(userId);
    await transaction(this.pool, async (c) => {
      await c.query(
        "SELECT id FROM operator_user WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
        [[actor.id, userId]],
      );
      await this.require(actor, undefined, false, c);
      const target = (
        await c.query("SELECT id FROM operator_user WHERE id=$1", [userId])
      ).rows[0];
      if (!target) throw new HttpError(404, "成员不存在");
      await c.query("DELETE FROM operator_session WHERE user_id=$1", [userId]);
      await c.query(
        "INSERT INTO audit_event(actor_id,action,detail) VALUES($1,'operator.session.revoke',$2)",
        [actor.id, { userId }],
      );
    });
  }

  async grant(
    actor: Operator,
    userId: string,
    siteId: string,
    role: "viewer" | "editor",
  ) {
    await this.require(actor);
    await transaction(this.pool, async (c) => {
      await c.query(
        "SELECT role FROM operator_grant WHERE user_id=$1 AND site_id=$2 FOR UPDATE",
        [userId, siteId],
      );
      await this.require(actor, undefined, false, c);
      await c.query(
        "INSERT INTO operator_grant VALUES($1,$2,$3) ON CONFLICT(user_id,site_id) DO UPDATE SET role=$3",
        [userId, siteId, role],
      );
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'operator.grant',$3)",
        [actor.id, siteId, { userId, role }],
      );
    });
  }
}
