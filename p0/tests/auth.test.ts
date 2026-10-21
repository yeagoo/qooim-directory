import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium,firefox,webkit,type BrowserContext,type Page} from '@playwright/test';
import type {Pool} from 'pg';
import {database} from './database.js';
import {authFixture} from '../internal/auth-fixture.js';
let pool:Pool,fixture:Awaited<ReturnType<typeof authFixture>>;
before(async()=>{pool=await database();fixture=await authFixture(pool);});
after(async()=>{await fixture?.close();await pool?.end();});
async function post(context:BrowserContext,origin:string,path:string,body:unknown) {
 const r=await context.request.post(origin+'/api/auth/'+path,{data:body,headers:{origin}});
 return {status:r.status(),body:await r.json()};
}
async function session(context:BrowserContext,origin:string){const r=await context.request.get(origin+'/session');return r.json();}
async function sharedLogin(page:Page,origin:string){await page.goto(origin);await page.locator('#shared').click();}
for(const engine of (process.env.P0_BROWSER_ONLY ? [chromium] : [chromium,firefox,webkit]))test(`A01–A04/A06/A08: ${engine.name()} actual cross-domain OIDC flow and isolated cookies`,async()=>{
 const browser=await engine.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 const page=await context.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);
 page.on('pageerror',error=>console.error('Browser script error:',error.message));
 page.on('response',r=>{if(r.status()>=400)console.error('HTTP failure:',r.status(),new URL(r.url()).pathname);});
 const [a,b,c,d]=fixture.origins;
 const email=`${engine.name()}@example.test`,password='Long-demo-password-103!';
 try{
  // Start from A, create account at B, return through actual code callback to A.
  await sharedLogin(page,a);
  await page.waitForURL(b+'/login?**');
  await page.locator('#email').fill(email);await page.locator('#password').fill(password);await page.locator('#register').click();
  await page.waitForURL(a+'/done');
  const sa=await session(context,a);assert.equal(sa.email,email);
  await sharedLogin(page,c);await page.waitForURL(c+'/done');
  const sc=await session(context,c);assert.equal(sc.email,email);
  assert.equal(sa.userId,sc.userId);assert.equal((await session(context,b)).userId,sa.userId);
  assert.equal(await session(context,d),null);
  const independent=await post(context,d,'sign-up/email',{email,password,name:'Independent'});assert.equal(independent.status,200);
  assert.notEqual((await session(context,d)).userId,sa.userId);
  const cookies=await context.cookies();
  for(const cookie of cookies.filter(v=>v.name.includes('session_token'))){assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.ok(fixture.hosts.includes(cookie.domain));assert.ok(!cookie.domain.startsWith('.'));}
  fixture.unavailable.add(fixture.hosts[1]);
  assert.equal((await session(context,a)).email,email);
  await pool.query(`UPDATE auth_2_session SET "expiresAt"=now()-interval '1 second' WHERE id IN (SELECT b.local_session FROM auth_bridge b JOIN identity_session ss ON ss.id=b.canonical_session WHERE ss.user_id=$1)`,[sc.userId]);
  assert.equal(await session(context,c),null);
  const unavailableLogin=await post(context,a,'sign-in/social',{provider:'network',callbackURL:a+'/done'});
  assert.equal((await context.request.get(unavailableLogin.body.url)).status(),503);
  await post(context,a,'sign-out',{});assert.equal(await session(context,a),null);
  await page.goto(a);assert.equal(await session(context,a),null);
  fixture.unavailable.delete(fixture.hosts[1]);
  await sharedLogin(page,a);await page.waitForURL(a+'/done');
  await sharedLogin(page,c);await page.waitForURL(c+'/done');
  assert.equal((await session(context,a)).email,email);
  await post(context,b,'sign-out',{});
  assert.equal((await pool.query('SELECT count(*) FROM identity_session WHERE user_id=$1 AND NOT revoked',[sa.userId])).rows[0].count,'0');
  assert.equal(await session(context,a),null);assert.equal(await session(context,c),null);
  assert.equal((await session(context,d)).email,email);
 }catch(error){console.error('Failed at',new URL(page.url()).pathname);throw error;}finally{fixture.unavailable.clear();await context.close();await browser.close();}
});
test('A05/A09: invalid callback state does not create session; reset link is owned by the correct space',async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true});
 try{
  await context.request.get(fixture.origins[0]+'/api/auth/callback/network?code=fake&state=wrong');
  assert.equal(await session(context,fixture.origins[0]),null);
  for(const index of [1,3])await post(context,fixture.origins[index],'sign-up/email',{email:'reset@example.test',password:'Long-demo-password-103!',name:'Reset test'});
  await post(context,fixture.origins[3],'request-password-reset',{email:'reset@example.test',redirectTo:fixture.origins[3]+'/reset'});
  assert.equal(fixture.resetLinks.at(-1)?.host,fixture.hosts[3]);
  assert.equal(new URL(fixture.resetLinks.at(-1)!.url).hostname,fixture.hosts[3]);
  const token=new URL(fixture.resetLinks.at(-1)!.url).pathname.split('/').at(-1);
  const reset=await post(context,fixture.origins[1],'reset-password',{token,newPassword:'Other-demo-password-103!'});
  assert.ok(reset.status>=400);
  assert.equal((await post(context,fixture.origins[1],'sign-in/email',{email:'reset@example.test',password:'Long-demo-password-103!'})).status,200);
  assert.equal((await post(context,fixture.origins[3],'reset-password',{token,newPassword:'Other-demo-password-103!'})).status,200);
  assert.ok((await post(context,fixture.origins[3],'reset-password',{token,newPassword:'Third-demo-password-103!'})).status>=400);
  assert.ok((await post(context,fixture.origins[3],'sign-in/email',{email:'reset@example.test',password:'Long-demo-password-103!'})).status>=400);
  assert.equal((await post(context,fixture.origins[3],'sign-in/email',{email:'reset@example.test',password:'Other-demo-password-103!'})).status,200);
 }finally{await context.close();await browser.close();}
});
for(const field of ['nonce','code_challenge'])test(`A05: tampered ${field} cannot create a relying-site session`,async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
 page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);
 const [a,b]=fixture.origins;
 try{
  const signed=await post(context,b,'sign-up/email',{email:`tamper-${field}@example.test`,password:'Long-demo-password-103!',name:'Tamper test'});assert.equal(signed.status,200);
  let altered=false;
  await page.route(b+'/api/auth/oauth2/authorize?**',async route=>{
   const url=new URL(route.request().url());assert.ok(url.searchParams.has(field));
   url.searchParams.set(field,(url.searchParams.get(field)??'')+'x');altered=true;await route.continue({url:url.toString()});
  });
  await sharedLogin(page,a);
  await page.waitForURL(url=>url.origin===a&&(url.pathname==='/api/auth/error'||url.searchParams.has('error')));
  assert.equal(altered,true);assert.equal(await session(context,a),null);
 }finally{await context.close();await browser.close();}
});
test('A05: consumed authorization callback cannot be replayed in another browser context',async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
 page.setDefaultTimeout(10000);const [a,b]=fixture.origins;let callback='';
 try{
  await post(context,b,'sign-up/email',{email:'replay@example.test',password:'Long-demo-password-103!',name:'Replay'});
  page.on('request',r=>{if(r.url().startsWith(a+'/api/auth/callback/network?'))callback=r.url();});
  await sharedLogin(page,a);await page.waitForURL(a+'/done');assert.ok(callback);
  const replay=await browser.newContext({ignoreHTTPSErrors:true});
  try{await replay.request.get(callback);assert.equal(await session(replay,a),null);}finally{await replay.close();}
 }finally{await context.close();await browser.close();}
});
test('A05: unregistered redirect URI is rejected rather than used as an open redirect',async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true});
 try{
  const start=await post(context,fixture.origins[0],'sign-in/social',{provider:'network',callbackURL:fixture.origins[0]+'/done'});
  const url=new URL(start.body.url);url.searchParams.set('redirect_uri','https://unregistered.invalid/callback');
  const result=await context.request.get(url.toString(),{maxRedirects:0});
  assert.ok([302,400].includes(result.status()));
  if(result.status()===302){
   const target=new URL(result.headers().location,fixture.origins[1]);
   assert.equal(target.origin,fixture.origins[1]);
   assert.equal(target.pathname,'/api/auth/error');
   assert.equal(target.searchParams.get('error'),'invalid_redirect');
  }
  assert.equal(await session(context,fixture.origins[0]),null);
 }finally{await context.close();await browser.close();}
});

test('Review: concurrent FIRST logins of one account bind each relying-site session to its own center session',async()=>{
 const browser=await chromium.launch({headless:true});
 const contexts=await Promise.all([browser.newContext({ignoreHTTPSErrors:true}),browser.newContext({ignoreHTTPSErrors:true})]);
 const pages=await Promise.all(contexts.map(c=>c.newPage()));const [a,b]=fixture.origins;
 let arrivals=0;let release!:()=>void;const barrier=new Promise<void>(r=>release=r);
 try{
  await post(contexts[0],b,'sign-up/email',{email:'concurrent-login@example.test',password:'Long-demo-password-103!',name:'Concurrent'});
  await post(contexts[1],b,'sign-in/email',{email:'concurrent-login@example.test',password:'Long-demo-password-103!'});
  fixture.setCallbackBarrier(async()=>{arrivals++;if(arrivals===2)release();await barrier;});
  await Promise.all(pages.map(async page=>{page.setDefaultTimeout(10000);await sharedLogin(page,a);await page.waitForURL(a+'/done');}));
  assert.equal(arrivals,2);
  assert.ok(await session(contexts[0],a));assert.ok(await session(contexts[1],a));
  await post(contexts[0],b,'sign-out',{});
  assert.equal(await session(contexts[0],a),null);assert.ok(await session(contexts[1],a));
 }finally{release();fixture.setCallbackBarrier();await Promise.all(contexts.map(c=>c.close()));await browser.close();}
});

test('Browser sessions enforce canonical preview roles, bans, revocation and site isolation',async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true});
 const page=await context.newPage();page.setDefaultTimeout(10000);const [a,b,c]=fixture.origins;
 try{
  await post(context,b,'sign-up/email',{email:'editor@example.test',password:'Long-demo-password-103!',name:'Editor'});
  await sharedLogin(page,a);await page.waitForURL(a+'/done');
  await sharedLogin(page,c);await page.waitForURL(c+'/done');
  const user=await session(context,a);assert.equal(user.userId,(await session(context,c)).userId);
  await pool.query("INSERT INTO resource(id) VALUES('preview-test'); INSERT INTO publication(site_id,resource_id,locale,slug,title) VALUES('0','preview-test','en','draft','Unpublished')");
  assert.equal((await context.request.get(a+'/preview')).status(),403);
  await pool.query("UPDATE identity_member SET role='editor' WHERE site_id='0' AND user_id=$1",[user.userId]);
  const preview=await context.request.get(a+'/preview');assert.equal(preview.status(),200);assert.equal(preview.headers()['cache-control'],'no-store');assert.equal((await preview.json())[0].title,'Unpublished');
  assert.equal((await context.request.get(c+'/preview')).status(),403);
  await pool.query("UPDATE identity_member SET role='reader' WHERE site_id='0' AND user_id=$1",[user.userId]);
  assert.equal((await context.request.get(a+'/preview')).status(),403);
  await pool.query('UPDATE identity_user SET banned=true WHERE id=$1',[user.userId]);
  assert.equal(await session(context,a),null);assert.equal(await session(context,c),null);assert.equal(await session(context,b),null);
  await pool.query('UPDATE identity_user SET banned=false WHERE id=$1',[user.userId]);
  await pool.query("UPDATE identity_session SET revoked=true WHERE site_id='0' AND user_id=$1",[user.userId]);
  assert.equal(await session(context,a),null);assert.ok(await session(context,c));
  await pool.query("ALTER VIEW auth_valid_session RENAME TO unavailable_auth_valid_session");
  try{assert.equal((await context.request.get(c+'/session')).status(),503);}finally{await pool.query('ALTER VIEW unavailable_auth_valid_session RENAME TO auth_valid_session');}
 }finally{await context.close();await browser.close();}
});

test('Concurrent first-login bursts do not starve database connections',async()=>{
 const browser=await chromium.launch({headless:true});
 const contexts=await Promise.all(Array.from({length:4},()=>browser.newContext({ignoreHTTPSErrors:true})));
 const [a,b]=fixture.origins;
 try{
  await post(contexts[0],b,'sign-up/email',{email:'burst@example.test',password:'Long-demo-password-103!',name:'Burst'});
  for(const context of contexts.slice(1))await post(context,b,'sign-in/email',{email:'burst@example.test',password:'Long-demo-password-103!'});
  const users=await Promise.all(contexts.map(async context=>{
   const page=await context.newPage();page.setDefaultTimeout(10000);
   await sharedLogin(page,a);await page.waitForURL(a+'/done');return (await session(context,a)).userId;
  }));
  assert.equal(new Set(users).size,1);
  assert.equal((await pool.query("SELECT count(*) FROM auth_0_user WHERE email='burst@example.test'")).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM pg_locks WHERE locktype=\'advisory\'')).rows[0].count,'0');
 }finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
});

test('Reconciliation repairs interrupted logout, preserves live sessions and never resurrects revocation',async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true});
 const page=await context.newPage();page.setDefaultTimeout(10000);const [a,b,c,d]=fixture.origins;
 try{
  await post(context,b,'sign-up/email',{email:'reconcile@example.test',password:'Long-demo-password-103!',name:'Reconcile'});
  await sharedLogin(page,a);await page.waitForURL(a+'/done');await sharedLogin(page,c);await page.waitForURL(c+'/done');
  await post(context,d,'sign-up/email',{email:'keep@example.test',password:'Long-demo-password-103!',name:'Keep'});
  const user=await session(context,a);
  await fixture.lifecycle.reconcile();assert.ok(await session(context,a));assert.ok(await session(context,d));
  // Simulate canonical center revocation without a library delete or downstream hook.
  await pool.query("UPDATE identity_session SET revoked=true WHERE site_id='1' AND user_id=$1",[user.userId]);
  assert.equal(await session(context,a),null);assert.equal(await session(context,c),null);
  await Promise.all([fixture.lifecycle.reconcile(2),fixture.lifecycle.reconcile(100)]);
  await fixture.lifecycle.reconcile();
  assert.equal((await pool.query('SELECT count(*) FROM identity_session WHERE user_id=$1 AND NOT revoked',[user.userId])).rows[0].count,'0');
  assert.ok(await session(context,d));
  // Age invalid library sessions past grace; fresh unrelated sessions remain intact.
  for(const role of [0,1,2])await pool.query(`UPDATE auth_${role}_session SET "createdAt"=now()-interval '10 minutes' WHERE id IN (SELECT b.local_session FROM auth_bridge b JOIN identity_session ss ON ss.id=b.canonical_session WHERE ss.user_id=$1 AND b.site_index=$2)`,[user.userId,role]);
  assert.ok((await fixture.lifecycle.reconcile()).removed>=3);
  assert.equal((await fixture.lifecycle.reconcile()).removed,0);
  assert.ok(await session(context,d));
 }finally{await context.close();await browser.close();}
});

test('Cleanup grace protects in-flight orphan; failed maintenance rolls back and retry is safe',async()=>{
 // Clone only fixture data to model an interrupted library create before bridge insertion.
 await pool.query(`INSERT INTO auth_3_session(id,token,"userId","expiresAt","createdAt","updatedAt")
  SELECT 'orphan-test','orphan-test-token',id,now()+interval '1 day',now(),now() FROM auth_3_user LIMIT 1`);
 await fixture.lifecycle.reconcile();
 assert.equal((await pool.query("SELECT count(*) FROM auth_3_session WHERE id='orphan-test'")).rows[0].count,'1');
 await pool.query("UPDATE auth_3_session SET \"createdAt\"=now()-interval '10 minutes' WHERE id='orphan-test'");
 await pool.query('ALTER TABLE session_maintenance_run ADD CONSTRAINT reject_run CHECK(removed<0) NOT VALID');
 try{await assert.rejects(fixture.lifecycle.reconcile());}finally{await pool.query('ALTER TABLE session_maintenance_run DROP CONSTRAINT reject_run');}
 assert.equal((await pool.query("SELECT count(*) FROM auth_3_session WHERE id='orphan-test'")).rows[0].count,'1');
 assert.ok((await fixture.lifecycle.reconcile()).removed>=1);
 assert.equal((await pool.query("SELECT count(*) FROM auth_3_session WHERE id='orphan-test'")).rows[0].count,'0');
 await assert.rejects(fixture.lifecycle.reconcile(0));
});

test('A04/R05: auth rejects unknown Host and untrusted Origin without creating sessions',async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true});
 try{
  const base=fixture.origins[1];
  const count=async()=>(await pool.query('SELECT count(*) FROM auth_1_session')).rows[0].count;
  const before=await count();
  const wrongHost=await context.request.get(base+'/api/auth/get-session',{headers:{host:'unknown.test','x-forwarded-host':fixture.hosts[1]}});
  assert.equal(wrongHost.status(),404);
  const wrongOrigin=await context.request.post(base+'/api/auth/sign-in/email',{headers:{origin:'https://untrusted.invalid'},data:{email:'reset@example.test',password:'Long-demo-password-103!'}});
  assert.equal(wrongOrigin.status(),403);assert.equal(await count(),before);
 }finally{await context.close();await browser.close();}
});
