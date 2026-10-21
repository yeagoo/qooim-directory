import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {database,seed} from './database.js';
import {OutboxWorker} from '../internal/outbox.js';
let pool:Pool,worker:OutboxWorker;
before(async()=>{pool=await database();worker=new OutboxWorker(pool);});
after(async()=>pool?.end());
beforeEach(async()=>{await pool.query('TRUNCATE site CASCADE');await seed(pool);});
async function enqueue(revision=1){await pool.query("INSERT INTO outbox(site_id,revision) VALUES('alpha',$1)",[revision]);}
test('Concurrent consumers claim once; duplicate and stale acknowledgements fail',async()=>{
 await enqueue();const jobs=await Promise.all([worker.claim(),worker.claim()]);
 const found=jobs.filter(j=>j!==undefined);assert.equal(found.length,1);
 assert.equal(await worker.deliver(found[0]),true);assert.equal(await worker.deliver(found[0]),false);
});
test('Abandoned lease is reclaimed and old worker cannot commit or fail new lease',async()=>{
 await enqueue();const old=(await worker.claim())!;
 await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second'");
 const replacement=(await worker.claim())!;assert.notEqual(old.lease_token,replacement.lease_token);
 assert.equal(await worker.deliver(old),false);assert.equal(await worker.fail(old),false);
 assert.equal(await worker.deliver(replacement),true);
});
test('Failed effect rolls back and retries with bounded attempts and sanitized error',async()=>{
 await enqueue();await pool.query('ALTER TABLE config_delivery ADD CONSTRAINT reject_effect CHECK(revision<0)');
 try{await assert.rejects(worker.runOnce());}finally{await pool.query('ALTER TABLE config_delivery DROP CONSTRAINT reject_effect');}
 assert.equal((await pool.query('SELECT count(*) FROM config_delivery')).rows[0].count,'0');
 assert.equal((await pool.query('SELECT status FROM outbox')).rows[0].status,'pending');
 assert.equal(await worker.claim(),undefined);
 await pool.query('UPDATE outbox SET available_at=now()');assert.equal(await worker.runOnce(),'done');
 await enqueue(2);const limited=new OutboxWorker(pool,30000,1);await limited.fail((await limited.claim())!);
 assert.equal((await pool.query("SELECT status FROM outbox WHERE revision=2")).rows[0].status,'failed');
});
test('Out-of-order deliveries never roll back consumer revision; crashed final attempt becomes failed',async()=>{
 await enqueue(2);await enqueue(1);assert.equal(await worker.runOnce(),'done');assert.equal(await worker.runOnce(),'done');
 assert.equal((await pool.query('SELECT revision FROM config_delivery')).rows[0].revision,2);
 await enqueue(3);const limited=new OutboxWorker(pool,1,1);await limited.claim();
 await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE status='processing'");
 assert.equal(await limited.claim(),undefined);
 assert.equal((await pool.query('SELECT status FROM outbox WHERE revision=3')).rows[0].status,'failed');
});

test('A killed consumer leaves a durable lease recoverable by another process',async()=>{
 const {fork}=await import('node:child_process');
 await enqueue();
 const child=fork(new URL('./abandon-outbox.ts',import.meta.url),{execArgv:['--import','tsx'],stdio:['ignore','ignore','inherit','ipc']});
 try{
  const job=await new Promise<{id:string}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Claim timed out')),5000);
   child.once('message',value=>{clearTimeout(timer);resolve(value as {id:string});});
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('exit',()=>{clearTimeout(timer);reject(new Error('Consumer exited before claim'));});
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  assert.equal((await pool.query('SELECT status FROM outbox WHERE id=$1',[job.id])).rows[0].status,'processing');
  await pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  assert.equal(await worker.runOnce(),'done');
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
