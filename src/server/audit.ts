import type { Pool } from "pg";
import { z } from "zod";
import { HttpError, Operators, type Operator } from "./operators.js";

const querySchema = z.strictObject({
  site: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,47}$/)
    .optional(),
  before: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export class AuditLog {
  private operators: Operators;
  constructor(private pool: Pool) {
    this.operators = new Operators(pool);
  }

  async list(actor: Operator, input: unknown) {
    const value = querySchema.parse(input);
    if (value.site) {
      await this.operators.require(actor, value.site);
      if (
        !(await this.pool.query("SELECT 1 FROM site WHERE id=$1", [value.site]))
          .rowCount
      )
        throw new HttpError(404, "站点不存在");
    } else {
      // An unscoped view spans every site and is therefore global-admin only.
      await this.operators.require(actor);
    }
    const rows = (
      await this.pool.query(
        `SELECT e.id,e.action,e.site_id,e.detail,e.created_at,
                u.email AS actor_email
           FROM audit_event e
           LEFT JOIN operator_user u ON u.id=e.actor_id
          WHERE ($1::bigint IS NULL OR e.id < $1)
            AND ($2::text IS NULL OR e.site_id=$2)
          ORDER BY e.id DESC
          LIMIT $3`,
        [value.before ?? null, value.site ?? null, value.limit],
      )
    ).rows;
    return {
      events: rows,
      nextBefore:
        rows.length === value.limit
          ? (rows[rows.length - 1].id as string)
          : null,
    };
  }
}
