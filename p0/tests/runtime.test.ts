import {before,after,test} from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {execFileSync,fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {database,seed} from './database.js';
import {Catalog} from '../internal/catalog.js';
let pool:Pool;
const children:ReturnType<typeof fork>[]=[];
const ports:number[]=[];
before(async()=>{
  pool=await database();await seed(pool);await seed(pool,'beta','beta.test');
  await pool.query("INSERT INTO resource VALUES('r',true,'private'),('hidden',false,'secret')");
  await pool.query("INSERT INTO publication VALUES('alpha','r','en','visible','Visible','directory','published'),('beta','r','en','other','Other','directory','published'),('alpha','hidden','en','secret','Secret','directory','published')");
  for(let i=0;i<2;i++){
    const child=fork(new URL('../internal/server.ts',import.meta.url),{execArgv:['--import','tsx'],stdio:['ignore','inherit','inherit','ipc']});children.push(child);
    const [message]=await once(child,'message');ports.push(message.port);
  }
});
after(async()=>{await Promise.all(children.map(async c=>{const done=once(c,'exit');c.kill();await done;}));await pool.end();});
const request=(index:number,path='/',host='alpha.test',extra={})=>new Promise<{status:number;cache:string|undefined;json:()=>Promise<any>}>((resolve,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port:ports[index],path,headers:{host,...extra}},res=>{
    let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,cache:res.headers['cache-control'],json:async()=>JSON.parse(body)}));
  });req.on('error',reject);req.end();
});
test('R05: Host-only, unknown and spoofed forwarded hosts cannot select a site',async()=>{
  assert.equal((await request(0,'/','unknown.test',{'x-forwarded-host':'alpha.test'})).status,404);
  const r=await request(0,'/','alpha.test',{'x-forwarded-host':'beta.test'});assert.equal(r.status,200);assert.equal((await r.json())[0].slug,'visible');
  assert.equal((await request(0,'/','alpha.test,beta.test')).status,404);
});
test('R07/R08: public projection, site/locale filtering, unpublished resources and anonymous preview',async()=>{
  assert.deepEqual(await (await request(0)).json(),[{slug:'visible',title:'Visible',locale:'en'}]);
  assert.deepEqual(await (await request(0,'/api/catalog?slug=visible')).json(),[{slug:'visible',title:'Visible',locale:'en'}]);
  assert.deepEqual(await (await request(0,'/api/catalog?slug=other')).json(),[]);
  assert.deepEqual(await (await request(0,'/?locale=zh')).json(),[]);
  assert.equal((await request(0,'/preview')).status,404);
  const catalog=new Catalog(pool);
  await assert.rejects(catalog.list({siteId:'alpha',host:'alpha.test'},'en'));
});
test('R02: two independent processes observe committed configuration after TTL',async()=>{
  for(let i=0;i<2;i++)assert.equal((await (await request(i,'/config')).json()).revision,0);
  const start=Date.now();
  await pool.query("UPDATE site SET revision=1,config=jsonb_set(config,'{name}','\"Updated\"') WHERE id='alpha'");
  await delay(550);
  for(let i=0;i<2;i++)assert.equal((await (await request(i,'/config')).json()).config.name,'Updated');
  console.log(`Configuration propagated across two processes in ${Date.now()-start}ms (test TTL 500ms)`);
});
test('R04: active/module/resource gates ignore cached display configuration',async()=>{
  await pool.query("UPDATE site SET active=false WHERE id='alpha'");assert.equal((await request(0)).status,404);
  await pool.query("UPDATE site SET active=true,modules='{}' WHERE id='alpha'");assert.deepEqual(await(await request(0)).json(),[]);
  await pool.query("UPDATE site SET modules=ARRAY['directory'] WHERE id='alpha'");
  await pool.query("UPDATE publication SET status='draft' WHERE site_id='alpha'");assert.deepEqual(await(await request(0)).json(),[]);
});
test('R08: authenticated editor preview is site-bound and no-store; draft translations excluded from sitemap',async()=>{
  await pool.query("UPDATE publication SET status='published' WHERE site_id='alpha' AND resource_id='r'");
  await pool.query("INSERT INTO publication VALUES('alpha','r','zh','draft','译文草稿','directory','draft')");
  await pool.query("INSERT INTO identity_space VALUES('preview','alpha'); INSERT INTO identity_site VALUES('alpha','preview'),('beta','preview')");
  const user=(await pool.query("INSERT INTO identity_user(space_id,email) VALUES('preview','editor@example.test') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO identity_member VALUES('alpha','preview',$1,'editor')",[user]);
  const token=(await pool.query("INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at) VALUES('alpha','preview',$1,'test',now()+interval '1 hour') RETURNING id",[user])).rows[0].id;
  const preview=await request(0,'/preview?locale=zh','alpha.test',{authorization:'Bearer '+token});
  assert.equal(preview.status,200);assert.equal((await preview.json())[0].title,'译文草稿');
  assert.equal(preview.cache,'no-store');
  assert.equal((await request(0,'/preview?locale=zh','beta.test',{authorization:'Bearer '+token})).status,404);
  assert.deepEqual((await(await request(0,'/sitemap')).json()).map((v:{locale:string})=>v.locale),['en']);
  await pool.query("UPDATE identity_session SET absolute_expires_at=now()-interval '1 second' WHERE id=$1",[token]);
  assert.equal((await request(0,'/preview?locale=zh','alpha.test',{authorization:'Bearer '+token})).status,404);
  await pool.query("UPDATE identity_session SET absolute_expires_at=now()+interval '1 hour' WHERE id=$1",[token]);
  await pool.query("UPDATE identity_member SET role='reader' WHERE user_id=$1",[user]);
  assert.equal((await request(0,'/preview','alpha.test',{authorization:'Bearer '+token})).status,404);
});
test('R03: authority read failure returns 503 instead of stale config',async()=>{
  await pool.query('ALTER TABLE site RENAME TO unavailable_site');
  try{assert.equal((await request(0,'/config')).status,503);}finally{await pool.query('ALTER TABLE unavailable_site RENAME TO site');}
});

test('Review/R03: actual database pause returns 503, processes survive and recover after resume',async()=>{
  const name=process.env.P0_RUN_ID!;
  assert.match(name,/^navigation-p0-[0-9a-f-]{36}$/);
  const docker=(...args:string[])=>execFileSync('sudo',['-n','docker',...args],{stdio:'pipe'});
  docker('pause',name);
  try{
    for(let i=0;i<2;i++)assert.equal((await request(i,'/config')).status,503);
  }finally{
    docker('unpause',name);
    const deadline=Date.now()+15000;
    let ready=false;
    do{try{docker('exec',name,'pg_isready','-h','127.0.0.1','-U','postgres');ready=true;break;}catch{}await delay(100);}while(Date.now()<deadline);
    assert.equal(ready,true);
  }
  let recovered=false;
  const recoveryDeadline=Date.now()+5000;
  do{if((await request(0,'/config')).status===200){recovered=true;break;}await delay(50);}while(Date.now()<recoveryDeadline);
  assert.equal(recovered,true);
});
