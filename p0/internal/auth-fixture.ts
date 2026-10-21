// Isolated feasibility fixture. Not a production auth adapter or public server.
import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';
import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {Pool,type PoolClient} from 'pg';
import {IdentityStore} from './identity.js';
import {installSessionViews,SessionLifecycle} from './session-lifecycle.js';
import {Catalog,NotFound} from './catalog.js';
import {betterAuth} from 'better-auth';
import {getMigrations} from 'better-auth/db/migration';
import {toNodeHandler,fromNodeHeaders} from 'better-auth/node';
import {jwt,genericOAuth} from 'better-auth/plugins';
import {oauthProvider} from '@better-auth/oauth-provider';

export async function authFixture(pool:Pool) {
 const hosts=process.env.P0_HOSTS!.split(',');
 // Separate admission pool: waiting callbacks must not exhaust the data-query pool.
 const locks=new Pool({connectionString:process.env.P0_DATABASE_URL,max:2,connectionTimeoutMillis:5000});
 locks.on('error',()=>console.error('Authentication lock connection failed'));
 locks.on('connect',client=>client.on('error',()=>console.error('Checked-out authentication lock connection failed')));
 const identities=new IdentityStore(pool);
 const catalog=new Catalog(pool);
 const callbackContext=new AsyncLocalStorage<{identity?:{sid:string;sub:string;email:string};lock?:PoolClient}>();
 for(let index=0;index<hosts.length;index++)await pool.query('INSERT INTO site(id,host,config) VALUES($1,$2,$3)',[String(index),hosts[index],{name:'Demo',template:'basic',locales:['en'],catalogPath:'tools',navigation:[],tagline:''}]);
 await pool.query("INSERT INTO identity_space VALUES('shared','1'),('independent','3'); INSERT INTO identity_site VALUES('0','shared'),('1','shared'),('2','shared'),('3','independent')");
 let callbackBarrier:(()=>Promise<void>)|undefined;
 await pool.query('CREATE TABLE auth_bridge(local_session text PRIMARY KEY, site_index integer NOT NULL, center_session text NOT NULL, subject text NOT NULL, local_user text NOT NULL, canonical_session uuid UNIQUE NOT NULL REFERENCES identity_session(id))');
 const map=new Map<string,{nodeHandler:ReturnType<typeof toNodeHandler>;session:(headers:Headers)=>Promise<{user:{id:string;email:string};session:{id:string}}|null>}>();
 const resetLinks:{host:string;url:string}[]=[];
 const unavailable=new Set<string>();
 const page=`<!doctype html><html><body><h1>Authentication feasibility fixture</h1>
 <label>Email <input id="email" type="email"></label><label>Password <input id="password" type="password"></label>
 <button id="register">Register</button><button id="login">Login</button><button id="shared">Shared login</button><pre id="result"></pre>
 <script>
 async function post(path,body){const r=await fetch('/api/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();document.querySelector('#result').textContent=JSON.stringify(data);if(data.url)location.assign(data.url);return data;}
 for(const kind of ['register','login'])document.querySelector('#'+kind).onclick=()=>post(kind==='register'?'sign-up/email':'sign-in/email',{email:document.querySelector('#email').value,password:document.querySelector('#password').value,name:'Demo',...(location.search?{oauth_query:location.search.slice(1)}:{})});
 document.querySelector('#shared').onclick=()=>post('sign-in/social',{provider:'network',callbackURL:location.origin+'/done'});
 </script></body></html>`;
 const server=createServer({key:await readFile(process.env.P0_TLS_KEY!),cert:await readFile(process.env.P0_TLS_CERT!)},async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const host=req.headers.host?.split(':')[0];
  const auth=host?map.get(host):undefined;
  if(!auth){res.writeHead(404);res.end('Not found');return;}
  if(unavailable.has(host!)){res.writeHead(503);res.end('Unavailable');return;}
  try{
   if(req.url?.startsWith('/api/auth/')||req.url?.startsWith('/.well-known/')){
    const path=new URL(req.url,'https://local').pathname;
    const index=hosts.indexOf(host!);
    if((index===0||index===2)&&!['/api/auth/sign-in/social','/api/auth/callback/network','/api/auth/sign-out'].includes(path)){
      res.writeHead(404);res.end('Not found');return;
    }
    await callbackContext.run({},async()=>{
     try{await auth.nodeHandler(req,res);}finally{const lock=callbackContext.getStore()?.lock;if(lock){try{await lock.query('ROLLBACK');}catch(error){lock.release(true);throw error;}lock.release();}}
    });return;
   }
   if(req.url==='/session'||req.url==='/preview'){
    const s=await auth.session(fromNodeHeaders(req.headers));
    const index=hosts.indexOf(host!);
    let identity:{user_id:string;canonical_session:string}|undefined;
    if(s){
     const valid=await pool.query('SELECT user_id,canonical_session FROM auth_valid_session WHERE local_session=$1 AND site_index=$2',[s.session.id,index]);
     identity=valid.rows[0];
    }
    res.setHeader('Content-Type','application/json');
    if(req.url==='/preview'){
     if(!identity){res.writeHead(403);res.end('{}');return;}
     try{const ctx=await catalog.resolve(req.headers.host);res.end(JSON.stringify(await catalog.preview(ctx,'en',identity.canonical_session)));}
     catch(error){if(error instanceof NotFound){res.writeHead(403);res.end('{}');}else throw error;}
     return;
    }
    res.end(JSON.stringify(identity?{userId:identity.user_id,email:s!.user.email}:null));return;
   }
   res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);
  }catch{if(!res.headersSent){res.writeHead(503);res.end('Unavailable');}else{res.destroy();}}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as AddressInfo).port;
 const origins=hosts.map(h=>`https://${h}:${port}`);
 const options=(index:number)=>({
  database:pool,baseURL:origins[index],secret:randomBytes(32).toString('hex'),trustedOrigins:[origins[index]],
  user:{modelName:`auth_${index}_user`},session:{modelName:`auth_${index}_session`,cookieCache:{enabled:false}},
  account:{modelName:`auth_${index}_account`,accountLinking:{enabled:false}},verification:{modelName:`auth_${index}_verification`},
  emailAndPassword:{enabled:true,sendResetPassword:async({url}:{url:string})=>{resetLinks.push({host:hosts[index],url});}},
  rateLimit:{enabled:false},logger:{disabled:true},
  advanced:{useSecureCookies:true},
 });
 try{
  const sessionHooks=(index:number)=>({session:{create:{after:async(session:{id:string;userId:string;expiresAt:Date})=>{
   const shared=index===0||index===2;
   let identity=callbackContext.getStore()?.identity;
   if(!shared){
    // Index comes exclusively from the fixed fixture role list, never request input.
    const {rows}=await pool.query(`SELECT email FROM auth_${index}_user WHERE id=$1`,[session.userId]);
    if(!rows[0])throw new Error('Missing authenticated user');
    identity={sid:session.id,sub:session.userId,email:rows[0].email};
   }
   if(!identity)throw new Error('Missing verified identity');
   const canonical=await identities.provisionVerifiedSubject({siteId:String(index),issuer:origins[shared?1:index]+'/api/auth',subject:identity.sub,email:identity.email});
   await pool.query(`WITH created AS (
    INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id
   ) INSERT INTO auth_bridge(local_session,site_index,center_session,subject,local_user,canonical_session)
    SELECT $6,$7,$4,$8,$9,id FROM created`,[String(index),canonical.spaceId,canonical.userId,identity.sid,session.expiresAt,session.id,index,identity.sub,session.userId]);
  }},delete:{before:async(session:{id:string})=>{
   // Fail closed before deleting the library session; partial failure can only revoke access.
   await pool.query(`UPDATE identity_session target SET revoked=true FROM auth_bridge b,identity_session source
    WHERE b.local_session=$1 AND b.site_index=$2 AND source.id=b.canonical_session
     AND (target.id=source.id OR ($2=1 AND target.space_id=source.space_id
      AND target.user_id=source.user_id AND target.center_session=source.center_session))`,[session.id,index]);
  }}}});
  const centerOptions={...options(1),databaseHooks:sessionHooks(1),plugins:[jwt(),oauthProvider({loginPage:'/login',consentPage:'/consent',grantTypes:['authorization_code'],scopes:['openid','profile','email'],clientPrivileges:({user})=>user?.email==='bootstrap@example.test'})]};
  await (await getMigrations(centerOptions)).runMigrations();
  const center=betterAuth(centerOptions);
  const bootstrap=await center.api.signUpEmail({body:{email:'bootstrap@example.test',password:randomBytes(24).toString('hex'),name:'Bootstrap'},asResponse:true});
  if(!bootstrap.ok)throw new Error('Bootstrap failed');
  const adminHeaders=new Headers({cookie:bootstrap.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')});
  map.set(hosts[1],{nodeHandler:toNodeHandler(center.handler),session:headers=>center.api.getSession({headers})});
  for(const index of [0,2,3]){
   let client;
   if(index!==3)client=await center.api.adminCreateOAuthClient({headers:adminHeaders,body:{redirect_uris:[`${origins[index]}/api/auth/callback/network`],skip_consent:true,enable_end_session:true,require_pkce:true,scope:'openid profile email',grant_types:['authorization_code'],token_endpoint_auth_method:'client_secret_post'}});
   const authOptions={...options(index),databaseHooks:sessionHooks(index),emailAndPassword:{...options(index).emailAndPassword,enabled:index===3},plugins:client?[genericOAuth({config:[{providerId:'network',clientId:client.client_id,clientSecret:client.client_secret!,discoveryUrl:`${origins[1]}/api/auth/.well-known/openid-configuration`,requireIdTokenVerification:true,getUserInfo:async tokens=>{
      // In pinned Better Auth 1.7.10 this hook runs AFTER JWKS/issuer/audience/nonce verification.
      if(!tokens.idToken)throw new Error('Missing verified ID token');
      const claims=z.object({iss:z.literal(origins[1]+'/api/auth'),sid:z.string().min(1),sub:z.string().min(1)}).parse(JSON.parse(Buffer.from(tokens.idToken.split('.')[1],'base64url').toString()));
      const response=await fetch(`${origins[1]}/api/auth/oauth2/userinfo`,{headers:{authorization:`Bearer ${tokens.accessToken}`},signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!response.ok)throw new Error('Userinfo unavailable');
      const profile=z.object({sub:z.literal(claims.sub),email:z.email(),name:z.string(),email_verified:z.boolean().optional()}).parse(await response.json());
      const context=callbackContext.getStore();if(!context)throw new Error('Missing callback context');
      context.identity={sid:claims.sid,sub:claims.sub,email:profile.email};
      await callbackBarrier?.();
      // Hold a database transaction lock through the library's user/account/session writes.
      // The lock is released in the request finally, including library error redirects.
      const lock=await locks.connect();context.lock=lock;
      await lock.query('BEGIN');await lock.query("SET LOCAL lock_timeout='5s'");
      await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([index,claims.iss,claims.sub])]);
      return {id:claims.sub,sub:claims.sub,email:profile.email,name:profile.name,emailVerified:profile.email_verified??false};
     },scopes:['openid','profile','email'],pkce:true,disableProviderLogout:true}]})]:[]};
   await(await getMigrations(authOptions)).runMigrations();
   const auth=betterAuth(authOptions);map.set(hosts[index],{nodeHandler:toNodeHandler(auth.handler),session:headers=>auth.api.getSession({headers})});
  }
  await installSessionViews(pool);
  const lifecycle=new SessionLifecycle(pool);
  return {hosts,origins,map,center,resetLinks,unavailable,lifecycle,setCallbackBarrier:(barrier?:()=>Promise<void>)=>{callbackBarrier=barrier;},close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await locks.end();}};
 }catch(e){server.closeAllConnections();server.close();await locks.end();throw e;}
}
