import {transaction} from './transaction.js';
import type {Pool} from 'pg';
import {z} from 'zod';

// Fixed fixture bindings, never derived from Host or a request parameter.
const roles=[0,1,2,3] as const;
export async function installSessionViews(pool:Pool){
 await pool.query(`CREATE VIEW auth_session_inventory AS ${roles.map(role=>`SELECT ${role} AS site_index,id AS local_session,"userId" AS local_user,"expiresAt" AS expires_at,"createdAt" AS created_at FROM auth_${role}_session`).join(' UNION ALL ')}`);
 await pool.query(`CREATE VIEW auth_valid_session AS
  SELECT b.local_session,b.site_index,b.canonical_session,ss.user_id
  FROM auth_bridge b JOIN auth_session_inventory lib ON (lib.site_index,lib.local_session,lib.local_user)=(b.site_index,b.local_session,b.local_user)
  JOIN identity_session ss ON ss.id=b.canonical_session AND ss.site_id=b.site_index::text
  JOIN identity_user u ON (u.id,u.space_id)=(ss.user_id,ss.space_id)
  JOIN identity_member m ON (m.site_id,m.space_id,m.user_id)=(ss.site_id,ss.space_id,ss.user_id)
  JOIN site s ON s.id=ss.site_id
  WHERE lib.expires_at>now() AND ss.expires_at>now() AND NOT ss.revoked AND NOT u.banned AND s.active
   AND (b.site_index IN (1,3) OR EXISTS (
    SELECT 1 FROM auth_session_inventory parent
    JOIN auth_bridge pb ON pb.site_index=1 AND pb.local_session=parent.local_session AND pb.local_user=parent.local_user
    JOIN identity_session ps ON ps.id=pb.canonical_session
    WHERE parent.site_index=1 AND parent.local_session=b.center_session AND parent.local_user=b.subject
     AND parent.expires_at>now() AND ps.expires_at>now() AND NOT ps.revoked
     AND ps.site_id='1' AND ps.user_id=ss.user_id AND ps.space_id=ss.space_id
   ))`);
 await pool.query(`CREATE TABLE session_maintenance_run (
  id bigserial PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT now(),
  revoked integer NOT NULL, removed integer NOT NULL
 )`);
}

export class SessionLifecycle {
 constructor(private pool:Pool){}
 // Revoke first. Cleanup never creates/relinks an identity or extends a session.
 async reconcile(limit=100){
  z.number().int().min(1).max(1000).parse(limit);
  return transaction(this.pool,async client=>{
   await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
   const revoked=await client.query(`WITH candidates AS (
    SELECT ss.id FROM identity_session ss WHERE NOT ss.revoked AND NOT EXISTS(
     SELECT 1 FROM auth_valid_session v WHERE v.canonical_session=ss.id)
    ORDER BY ss.id FOR UPDATE OF ss SKIP LOCKED LIMIT $1
   ) UPDATE identity_session ss SET revoked=true FROM candidates c WHERE ss.id=c.id`,[limit]);
   let removed=0;
   for(const role of roles){
    // Grace period protects newly inserted library sessions whose after-hook is in flight.
    // Library sessions are disposable; canonical records/bridge remain for diagnosis.
    const result=await client.query(`WITH candidates AS (
     SELECT lib.id FROM auth_${role}_session lib WHERE lib."createdAt"<now()-interval '5 minutes'
      AND NOT EXISTS(SELECT 1 FROM auth_valid_session v WHERE v.site_index=$1 AND v.local_session=lib.id)
     ORDER BY lib.id FOR UPDATE OF lib SKIP LOCKED LIMIT $2
    ) DELETE FROM auth_${role}_session lib USING candidates c WHERE lib.id=c.id`,[role,limit]);
    removed+=result.rowCount??0;
   }
   const counts={revoked:revoked.rowCount??0,removed};
   await client.query('INSERT INTO session_maintenance_run(revoked,removed) VALUES($1,$2)',[counts.revoked,counts.removed]);
   return counts;
  });
 }
}
