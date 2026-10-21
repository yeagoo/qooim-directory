import { createServer } from 'node:http';
import { Pool } from 'pg';
import { Catalog,NotFound } from './catalog.js';
const pool=new Pool({connectionString:process.env.P0_DATABASE_URL,connectionTimeoutMillis:1000,query_timeout:2000});
pool.on('error',()=>console.error('Idle database connection lost; new requests will reconnect or fail closed'));
const catalog=new Catalog(pool,500);
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try {
    const ctx=await catalog.resolve(req.headers.host);
    const url=new URL(req.url??'/','http://local');
    if(!['/','/api/catalog','/config','/preview','/sitemap'].includes(url.pathname))throw new NotFound();
    const data=url.pathname==='/preview' ? await catalog.preview(ctx,url.searchParams.get('locale')??'en',req.headers.authorization?.replace(/^Bearer /,'')??'')
      : url.pathname==='/sitemap' ? await catalog.sitemap(ctx)
      : url.pathname==='/config' ? await catalog.configuration(ctx) : await catalog.list(ctx,url.searchParams.get('locale')??'en',url.searchParams.get('slug')??undefined);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
  } catch(e) {res.statusCode=e instanceof NotFound?404:503;res.end(res.statusCode===404?'Not found':'Unavailable');}
});
server.listen(0,'127.0.0.1',()=>process.send?.({port:(server.address() as import('node:net').AddressInfo).port}));
let stopping=false;
const stop=()=>{if(stopping)return;stopping=true;server.closeAllConnections();server.close(()=>{void pool.end().then(()=>process.exit());});};
process.on('SIGTERM',stop);process.on('disconnect',stop);
