import {Pool} from 'pg';
import {Catalog,NotFound} from './catalog.js';
let catalog:Catalog;
export async function publicResponse(request:Request) {
 const headers={'Cache-Control':'no-store'};
 try {
  if(!catalog){
    const pool=new Pool({connectionString:process.env.P0_DATABASE_URL,connectionTimeoutMillis:1000,query_timeout:2000});
    pool.on('error',()=>console.error('Idle database connection lost; requests remain fail-closed'));
    catalog=new Catalog(pool);
  }
  const ctx=await catalog.resolve(request.headers.get('host')??undefined);
  const url=new URL(request.url);
  if(url.pathname==='/preview')throw new NotFound();
  const snapshot=await catalog.configuration(ctx);
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length<2||parts.length>3)throw new NotFound();
  const [locale,segment,slug]=parts;
  if(!snapshot.config.locales.includes(locale as 'en'|'zh') || segment!==snapshot.config.catalogPath)throw new NotFound();
  const items=await catalog.list(ctx,locale,slug);
  if(slug&&!items.length)throw new NotFound();
  return Response.json({site:ctx.siteId,name:snapshot.config.name,items},{headers});
 } catch(e){return new Response(e instanceof NotFound?'Not found':'Unavailable',{status:e instanceof NotFound?404:503,headers});}
}
