import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ConfigStore, Conflict, InvalidReference } from '../internal/config.js';
import { database, seed, basic } from './database.js';
let pool: Pool;
let store: ConfigStore;
const snapshot=(config:unknown=basic,revision=0,siteId='alpha')=>({schemaVersion:1,siteId,baseRevision:revision,config});
before(async()=>{pool=await database();store=new ConfigStore(pool,new Set(['basic','editorial']));});
after(async()=>pool?.end());
beforeEach(async()=>{await pool.query('TRUNCATE site CASCADE');await seed(pool);});

test('C01/C02/C07: concurrent writers serialize on a database lock, stale draft cannot overwrite',async()=>{
  const lock=await pool.connect(); await lock.query('BEGIN'); await lock.query("SELECT id FROM site WHERE id='alpha' FOR UPDATE");
  const a=store.save('alpha',snapshot({...basic,name:'A'}),{revision:0,draftVersion:0});
  const b=store.save('alpha',snapshot({...basic,name:'B'}),{revision:0,draftVersion:0});
  const resultsPromise=Promise.allSettled([a,b]);
  try {
    const deadline=Date.now()+3000;
    let waiting=0;
    do {
      waiting=Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM site WHERE id=%'")).rows[0].n);
      if(waiting===2)break;
      await new Promise(r=>setTimeout(r,10));
    }while(Date.now()<deadline);
    assert.equal(waiting,2,'both writers must be blocked at the database before releasing the barrier');
  }finally{await lock.query('COMMIT');lock.release();}
  const results=await resultsPromise;
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&r.reason instanceof Conflict).length,1);
  await assert.rejects(store.save('alpha',snapshot(),{revision:0,draftVersion:1}),Conflict);
  assert.equal((await store.read('alpha')).revision,0);
});
test('C03/C06: array replacement preserves order, missing optional fields reset, missing required/null/duplicates rejected',async()=>{
  const navigation=[{id:'two',label:'Two',href:'/two'},{id:'one',label:'One',href:'/one'}];
  await store.save('alpha',snapshot({...basic,navigation}),{revision:0,draftVersion:0});
  assert.deepEqual((await store.read('alpha')).draft?.navigation,navigation);
  await store.save('alpha',snapshot({name:'new',template:'basic',locales:['en']}),{revision:0,draftVersion:1},true);
  assert.deepEqual((await store.read('alpha')).draft?.navigation,[]);
  for(const config of [{template:'basic',locales:['en']},{...basic,tagline:null},{...basic,navigation:[navigation[0],navigation[0]]}])
    await assert.rejects(store.save('alpha',snapshot(config),{revision:0,draftVersion:2},true));
  assert.equal((await store.read('alpha')).draft_version,2);
});
test('C04/C05: validate target/schema/fields; duplicate command returns original revision',async()=>{
  for(const input of [{...snapshot(),schemaVersion:0},{...snapshot(),extra:true},snapshot(basic,0,'other'),snapshot({...basic,secret:'x'})])
    await assert.rejects(store.save('alpha',input,{revision:0,draftVersion:0}));
  await store.save('alpha',snapshot(),{revision:0,draftVersion:0});
  const id=randomUUID(), expected={revision:0,draftVersion:1};
  assert.equal(await store.publish('alpha',expected,id),1);
  assert.equal(await store.publish('alpha',expected,id),1);
  await assert.rejects(store.publish('alpha',{revision:1,draftVersion:2},id),Conflict);
  assert.equal((await pool.query('SELECT * FROM outbox')).rowCount,1);
});
test('C08: draft changed during publication rejects stale request',async()=>{
  await store.save('alpha',snapshot(),{revision:0,draftVersion:0});
  await store.save('alpha',snapshot({...basic,name:'new'}),{revision:0,draftVersion:1},true);
  await assert.rejects(store.publish('alpha',{revision:0,draftVersion:1},randomUUID()),Conflict);
  assert.equal((await store.read('alpha')).revision,0);
});
test('C09: database failure at outbox insert rolls back revision, pointer and operation',async()=>{
  await store.save('alpha',snapshot(),{revision:0,draftVersion:0});
  await pool.query("ALTER TABLE outbox ADD CONSTRAINT fault CHECK (revision < 0)");
  try { await assert.rejects(store.publish('alpha',{revision:0,draftVersion:1},randomUUID())); }
  finally {await pool.query('ALTER TABLE outbox DROP CONSTRAINT fault');}
  assert.equal((await store.read('alpha')).revision,0);
  assert.equal((await pool.query('SELECT * FROM config_revision')).rowCount,1);
  assert.equal((await pool.query('SELECT * FROM config_operation')).rowCount,0);
});
test('C10: lost response/notification leaves durable pending event and idempotent operation',async()=>{
  await store.save('alpha',snapshot(),{revision:0,draftVersion:0});
  const id=randomUUID(); await store.publish('alpha',{revision:0,draftVersion:1},id);
  assert.equal((await pool.query('SELECT status FROM outbox')).rows[0].status,'pending');
  assert.equal(await store.publish('alpha',{revision:0,draftVersion:1},id),1);
});
test('C11: rollback validates current installed templates and creates newer revision',async()=>{
  await store.save('alpha',snapshot({...basic,template:'editorial'}),{revision:0,draftVersion:0});
  await store.publish('alpha',{revision:0,draftVersion:1},randomUUID());
  const restricted=new ConfigStore(pool,new Set(['editorial']));
  await assert.rejects(restricted.rollback('alpha',0,{revision:1,draftVersion:2}),InvalidReference);
  await store.rollback('alpha',0,{revision:1,draftVersion:2});
  assert.equal(await store.publish('alpha',{revision:1,draftVersion:3},randomUUID()),2);
  assert.equal((await store.read('alpha')).config.template,'basic');
});

test('Review: equivalent JSONB key order does not increment draft version, but stale versions still fail',async()=>{
  await store.save('alpha',snapshot(),{revision:0,draftVersion:0});
  assert.equal(await store.save('alpha',snapshot(),{revision:0,draftVersion:1},true),1);
  await assert.rejects(store.save('alpha',snapshot(),{revision:0,draftVersion:0},true),Conflict);
});

test('C03/C07: preview shows complete array deletion/reorder against existing draft without writing',async()=>{
  const navigation=[{id:'one',label:'One',href:'/one'},{id:'two',label:'Two',href:'/two'}];
  await store.save('alpha',snapshot({...basic,navigation}),{revision:0,draftVersion:0});
  const preview=await store.preview('alpha',snapshot({...basic,navigation:[navigation[1]]}));
  assert.equal(preview.replacesDraft,true);
  assert.deepEqual(preview.differences,[{field:'navigation',before:navigation,after:[navigation[1]]}]);
  assert.equal((await store.read('alpha')).draft_version,1);
});

test('C09: terminating publisher backend before commit leaves no partial release and retry succeeds',async()=>{
 await store.save('alpha',snapshot(),{revision:0,draftVersion:0});
 const guard=await pool.connect();const operation=randomUUID();
 await guard.query('SELECT pg_advisory_lock(918273)');
 await pool.query(`CREATE FUNCTION block_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(918273); RETURN NEW; END $$;
 CREATE TRIGGER block_publication BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION block_publication()`);
 const pending=store.publish('alpha',{revision:0,draftVersion:1},operation).then(()=>({failed:false}),()=>({failed:true}));
 try{
  let pid:number|undefined;const deadline=Date.now()+5000;
  do{
   pid=(await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO outbox%'" )).rows[0]?.pid;
   if(pid)break;await new Promise(resolve=>setTimeout(resolve,10));
  }while(Date.now()<deadline);
  assert.ok(pid,'publisher must be blocked after changing the unpublished transaction');
  await pool.query('SELECT pg_terminate_backend($1)',[pid]);
  assert.equal((await pending).failed,true);
 }finally{
  await guard.query('SELECT pg_advisory_unlock(918273)');guard.release();
  await pending;
  await pool.query('DROP TRIGGER block_publication ON outbox; DROP FUNCTION block_publication()');
 }
 assert.equal((await store.read('alpha')).revision,0);
 assert.equal((await pool.query('SELECT count(*) FROM outbox')).rows[0].count,'0');
 assert.equal((await pool.query('SELECT count(*) FROM config_operation')).rows[0].count,'0');
 assert.equal(await store.publish('alpha',{revision:0,draftVersion:1},operation),1);
});
