import { transaction } from "./transaction.js";
import type { Pool } from "pg";
import { z } from "zod";
export type Delivery = {
  id: string;
  site_id: string;
  revision: number;
  lease_token: string;
  attempts: number;
};

// At-least-once delivery. Every consumer must be idempotent; a lease cannot fence external APIs.
export class OutboxWorker {
  constructor(
    private pool: Pool,
    private leaseMs = 30_000,
    private maxAttempts = 5,
  ) {
    z.number().int().min(1).max(3_600_000).parse(leaseMs);
    z.number().int().min(1).max(100).parse(maxAttempts);
  }
  async claim(): Promise<Delivery | undefined> {
    await this.pool.query(
      `UPDATE outbox SET status='failed',lease_token=NULL,lease_until=NULL,last_error='attempts_exhausted'
   WHERE attempts >= $1 AND (status='pending' OR (status='processing' AND lease_until<=clock_timestamp()))`,
      [this.maxAttempts],
    );
    const result = await this.pool.query<Delivery>(
      `WITH candidate AS (
   SELECT id FROM outbox WHERE attempts<$1 AND
    ((status='pending' AND available_at<=clock_timestamp()) OR (status='processing' AND lease_until<=clock_timestamp()))
   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE outbox o SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
   lease_until=clock_timestamp()+$2::integer*interval '1 millisecond'
   FROM candidate c WHERE o.id=c.id RETURNING o.id,o.site_id,o.revision,o.lease_token,o.attempts`,
      [this.maxAttempts, this.leaseMs],
    );
    return result.rows[0];
  }
  async fail(job: Delivery) {
    const result = await this.pool.query(
      `UPDATE outbox SET status=CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
   available_at=clock_timestamp()+LEAST(300,POWER(2,attempts)) * interval '1 second',
   lease_token=NULL,lease_until=NULL,last_error='delivery_failed'
   WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()`,
      [job.id, job.lease_token, this.maxAttempts],
    );
    return result.rowCount === 1;
  }
  // Local durable projection: effect and acknowledgement commit together under the lease row lock.
  async deliver(job: Delivery) {
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT site_id,revision FROM outbox WHERE id=$1 AND lease_token=$2
    AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE`,
        [job.id, job.lease_token],
      );
      if (!rows.length) return false;
      await client.query(
        `INSERT INTO config_delivery(site_id,revision) VALUES($1,$2)
    ON CONFLICT(site_id) DO UPDATE SET revision=GREATEST(config_delivery.revision,excluded.revision)`,
        [rows[0].site_id, rows[0].revision],
      );
      await client.query(
        "UPDATE outbox SET status='done',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1",
        [job.id],
      );
      return true;
    });
  }
  async runOnce() {
    const job = await this.claim();
    if (!job) return "idle";
    try {
      return (await this.deliver(job)) ? "done" : "lease-lost";
    } catch (error) {
      await this.fail(job);
      throw error;
    }
  }
}
