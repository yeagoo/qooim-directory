import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {database,seed} from './database.js';
import {IdentityStore} from '../internal/identity.js';
let pool:Pool,store:IdentityStore,shared:string,independent:string;
let sessions:string[]=[];
before(async()=>{
 pool=await database();store=new IdentityStore(pool);
 for(const site of ['a','b','c'])await seed(pool,site,site+'.test');
 await pool.query("INSERT INTO identity_space VALUES('shared','b'),('independent','c')");
 await pool.query("INSERT INTO identity_site VALUES('a','shared'),('b','shared'),('c','independent')");
 shared=(await pool.query("INSERT INTO identity_user(space_id,email) VALUES('shared','same@example.test') RETURNING id")).rows[0].id;
 independent=(await pool.query("INSERT INTO identity_user(space_id,email) VALUES('independent','same@example.test') RETURNING id")).rows[0].id;
 await pool.query("INSERT INTO identity_member VALUES('a','shared',$1,'editor'),('b','shared',$1,'editor'),('c','independent',$2,'reader')",[shared,independent]);
 sessions=(await pool.query("INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at) VALUES('a','shared',$1,'center-1',now()+interval '1 hour'),('b','shared',$1,'center-1',now()+interval '1 hour'),('a','shared',$1,'center-2',now()+interval '1 hour') RETURNING id",[shared])).rows.map(r=>r.id);
});
after(async()=>pool?.end());
test('A01/A03: shared identity IDs do not merge independent spaces; composite foreign keys prevent cross-space business data',async()=>{
 assert.notEqual(shared,independent);
 await assert.rejects(pool.query("INSERT INTO identity_member VALUES('c','shared',$1,'reader')",[shared]),{code:'23503'});
 assert.equal(await store.authorize(sessions[0],'b','editor'),false);
});
test('A10: database uniqueness rejects concurrent same-space registrations and provider subject collisions',async()=>{
 const first=await pool.connect();await first.query('BEGIN');
 await first.query("INSERT INTO identity_user(space_id,email) VALUES('shared','concurrent@example.test')");
 const other=pool.query("INSERT INTO identity_user(space_id,email) VALUES('shared','concurrent@example.test')");
 const rejected=assert.rejects(other,{code:'23505'});
 await first.query('COMMIT');first.release();await rejected;
 await pool.query("INSERT INTO identity_subject VALUES('shared','issuer','subject',$1)",[shared]);
 await assert.rejects(pool.query("INSERT INTO identity_subject VALUES('shared','issuer','subject',$1)",[shared]),{code:'23505'});
});
test('A07: ban/permission revoke and database failure fail closed without configuration cache',async()=>{
 assert.equal(await store.authorize(sessions[0],'a','editor'),true);
 await pool.query('UPDATE identity_user SET banned=true WHERE id=$1',[shared]);assert.equal(await store.authorize(sessions[0],'a','editor'),false);
 await pool.query('UPDATE identity_user SET banned=false WHERE id=$1',[shared]);
 await pool.query("UPDATE identity_member SET role='reader' WHERE site_id='a'");assert.equal(await store.authorize(sessions[0],'a','editor'),false);
 await pool.query('ALTER TABLE identity_session RENAME TO broken_session');
 try{await assert.rejects(store.authorize(sessions[0],'a'));}finally{await pool.query('ALTER TABLE broken_session RENAME TO identity_session');}
});
test('A08: whole-space logout revokes linked center session but not another device or unrelated space',async()=>{
 await store.revokeGroup(sessions[0],'b');assert.equal(await store.authorize(sessions[1],'b','editor'),true);
 await store.revokeGroup(sessions[0],'a');assert.equal(await store.authorize(sessions[1],'b','editor'),false);
 assert.equal(await store.authorize(sessions[2],'a'),true);
});
test('A11: occupied site cannot change space and center cannot be deleted',async()=>{
 await assert.rejects(pool.query("UPDATE identity_site SET space_id='independent' WHERE site_id='a'"),{code:'23503'});
 await assert.rejects(pool.query("DELETE FROM site WHERE id='b'"),{code:'23503'});
});
test('A12: migration dry-run reports same-email collision without merging identity or roles',async()=>{
 const result=await store.migrationConflicts('independent','shared');
 assert.equal(result.length,1);assert.equal(result[0].source,independent);assert.equal(result[0].target,shared);
 assert.equal((await pool.query('SELECT * FROM identity_user')).rowCount,3);
 assert.equal((await pool.query("SELECT role FROM identity_member WHERE site_id='c'")).rows[0].role,'reader');
});

test('Verified subject provisioning serializes first login, shares IDs across sites, and never links by email',async()=>{
 const input={siteId:'a',issuer:'https://center.example.test',subject:'first-login',email:'fresh@example.test'};
 const results=await Promise.all([store.provisionVerifiedSubject(input),store.provisionVerifiedSubject({...input,siteId:'b'})]);
 assert.equal(results[0].userId,results[1].userId);
 assert.equal((await pool.query('SELECT count(*) FROM identity_member WHERE user_id=$1',[results[0].userId])).rows[0].count,'2');
 await assert.rejects(store.provisionVerifiedSubject({...input,subject:'different-subject'}),/Explicit account linking/);
 assert.equal((await pool.query("SELECT count(*) FROM identity_subject WHERE subject='different-subject'")).rows[0].count,'0');
 const independent=await store.provisionVerifiedSubject({...input,siteId:'c'});assert.notEqual(independent.userId,results[0].userId);
 await pool.query('UPDATE identity_user SET banned=true WHERE id=$1',[results[0].userId]);
 await assert.rejects(store.provisionVerifiedSubject(input),/Identity unavailable/);
});

test('A11: supported space-switch entry diagnoses occupied sites and moves only empty non-centers',async()=>{
 await assert.rejects(store.switchEmptySite('a','independent'),/members.*sessions.*favorites.*centers/);
 await assert.rejects(store.switchEmptySite('b','independent'),/centers":1/);
 await seed(pool,'empty');await pool.query("INSERT INTO identity_site VALUES('empty','shared')");
 await store.switchEmptySite('empty','independent');
 assert.equal((await pool.query("SELECT space_id FROM identity_site WHERE site_id='empty'")).rows[0].space_id,'independent');
 await assert.rejects(store.switchEmptySite('empty','missing'),/Unknown/);
});

test('A12: hypothetical merges report duplicate favorites, external binding and permission conflicts without writes',async()=>{
 const {inspectMigration}=await import('../internal/migration-model.js');
 const second=(await pool.query("INSERT INTO identity_user(space_id,email) VALUES('independent','merge@example.test') RETURNING id")).rows[0].id;
 await pool.query("INSERT INTO identity_member VALUES('c','independent',$1,'editor')",[second]);
 await pool.query("INSERT INTO resource(id) VALUES('migration-resource')");
 await pool.query("INSERT INTO favorite VALUES('c','independent',$1,'migration-resource'),('c','independent',$2,'migration-resource'),('a','shared',$3,'migration-resource')",[independent,second,shared]);
 await pool.query("INSERT INTO identity_subject VALUES('independent','issuer','subject',$1)",[second]);
 const snapshot=async()=>Promise.all(['identity_user','identity_member','identity_subject','favorite','identity_site','identity_session'].map(async table=>(await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
 const before=await snapshot();
 const report=await inspectMigration(pool,'independent','shared',[{source:independent,target:shared},{source:second,target:shared}]);
 assert.equal(report.executable,false);assert.equal(report.controlProofRequired.length,2);
 assert.equal(report.duplicateFavorites.length,1);assert.equal(report.duplicateFavorites[0].siteId,'c');
 assert.deepEqual(new Set(report.duplicateFavorites[0].sources),new Set([independent,second]));
 assert.equal(report.permissions.find(p=>p.source===second)?.sourceRoles[0].role,'editor');
 assert.equal(report.permissions.find(p=>p.source===second)?.newSiteRole,'reader');
 assert.equal(report.permissions[0].retainedTargetRoles.find(r=>r.site_id==='a')?.role,'reader');
 assert.ok(report.emailConflicts.some(c=>c.source===independent&&c.target===shared));
 const another=(await pool.query("SELECT id FROM identity_user WHERE space_id='shared' AND email='fresh@example.test'")).rows[0].id;
 const conflict=await inspectMigration(pool,'independent','shared',[{source:second,target:another}]);
 assert.deepEqual(conflict.externalConflicts.find(c=>c.sourceUser===second),{issuer:'issuer',subject:'subject',sourceUser:second,boundTarget:shared,proposedTarget:another});assert.ok(conflict.unmapped.includes(independent));
 await assert.rejects(inspectMigration(pool,'independent','shared',[{source:shared,target:second}]),/Mapping crosses/);
 await assert.rejects(inspectMigration(pool,'independent','shared',[{source:second,target:shared},{source:second,target:another}]));
 assert.deepEqual(await snapshot(),before);
});

test('absolute session expiry denies authorization even while rolling expiry is valid', async()=>{
 const token=(await pool.query("INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at,absolute_expires_at) VALUES('a','shared',$1,'absolute-test',now()+interval '1 hour',now()-interval '1 second') RETURNING id",[shared])).rows[0].id;
 assert.equal(await store.authorize(token,'a'),false);
});

test('absolute-expired source cannot revoke another session in its logout group', async()=>{
 const tokens=(await pool.query("INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at) VALUES('a','shared',$1,'absolute-logout-test',now()+interval '1 hour'),('b','shared',$1,'absolute-logout-test',now()+interval '1 hour') RETURNING id",[shared])).rows.map(r=>r.id);
 await pool.query("UPDATE identity_session SET absolute_expires_at=now()-interval '1 second' WHERE id=$1",[tokens[0]]);
 await store.revokeGroup(tokens[0],'a');
 assert.equal((await pool.query('SELECT revoked FROM identity_session WHERE id=$1',[tokens[1]])).rows[0].revoked,false);
});
