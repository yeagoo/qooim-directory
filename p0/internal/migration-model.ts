import {transaction} from './transaction.js';
import type {Pool} from 'pg';
import {z} from 'zod';

const mappingSchema=z.array(z.strictObject({source:z.uuid(),target:z.uuid()})).max(1000)
 .refine(rows=>new Set(rows.map(row=>row.source)).size===rows.length,'Duplicate source mapping');

// Read-only model exercise. Supplied mappings are hypotheses, not proof of account control.
export async function inspectMigration(pool:Pool,sourceSpace:string,targetSpace:string,input:unknown){
 const mappings=mappingSchema.parse(input);
 if(sourceSpace===targetSpace)throw new Error('Spaces must differ');
 return transaction(pool,async client=>{
  const spaces=await client.query('SELECT id FROM identity_space WHERE id=ANY($1::text[])',[[sourceSpace,targetSpace]]);
  if(spaces.rowCount!==2)throw new Error('Unknown account space');
  const users=(await client.query<{id:string;space_id:string;email:string}>('SELECT id,space_id,email FROM identity_user WHERE space_id=ANY($1::text[]) ORDER BY id',[[sourceSpace,targetSpace]])).rows;
  for(const mapping of mappings){
   if(!users.some(u=>u.id===mapping.source&&u.space_id===sourceSpace)||!users.some(u=>u.id===mapping.target&&u.space_id===targetSpace))throw new Error('Mapping crosses declared space');
  }
  const targetBySource=new Map(mappings.map(m=>[m.source,m.target]));
  const members=(await client.query<{site_id:string;user_id:string;role:string}>('SELECT site_id,user_id,role FROM identity_member WHERE space_id=ANY($1::text[]) ORDER BY site_id,user_id',[[sourceSpace,targetSpace]])).rows;
  const favorites=(await client.query<{site_id:string;user_id:string;resource_id:string}>('SELECT site_id,user_id,resource_id FROM favorite WHERE space_id=ANY($1::text[]) ORDER BY site_id,user_id,resource_id',[[sourceSpace,targetSpace]])).rows;
  const subjects=(await client.query<{space_id:string;issuer:string;subject:string;user_id:string}>('SELECT space_id,issuer,subject,user_id FROM identity_subject WHERE space_id=ANY($1::text[]) ORDER BY issuer,subject,user_id',[[sourceSpace,targetSpace]])).rows;
  const favoriteGroups=new Map<string,{siteId:string;targetUser:string;resourceId:string;sources:string[]}>();
  for(const favorite of favorites){
   const target=targetBySource.get(favorite.user_id)??(users.some(u=>u.id===favorite.user_id&&u.space_id===targetSpace)?favorite.user_id:undefined);
   if(!target)continue;
   const key=JSON.stringify([favorite.site_id,target,favorite.resource_id]);
   const group=favoriteGroups.get(key)??{siteId:favorite.site_id,targetUser:target,resourceId:favorite.resource_id,sources:[]};
   group.sources.push(favorite.user_id);favoriteGroups.set(key,group);
  }
  const permissions=mappings.map(mapping=>({
   ...mapping,
   sourceRoles:members.filter(m=>m.user_id===mapping.source),
   retainedTargetRoles:members.filter(m=>m.user_id===mapping.target),
   newSiteRole:'reader' as const,requiresExplicitGrant:true,
  }));
  const externalConflicts=subjects.filter(s=>s.space_id===sourceSpace).flatMap(source=>subjects
   .filter(t=>t.space_id===targetSpace&&t.issuer===source.issuer&&t.subject===source.subject&&t.user_id!==targetBySource.get(source.user_id))
   .map(target=>({issuer:source.issuer,subject:source.subject,sourceUser:source.user_id,boundTarget:target.user_id,proposedTarget:targetBySource.get(source.user_id)??null})));
  const emailConflicts=users.filter(u=>u.space_id===sourceSpace).flatMap(source=>users.filter(t=>t.space_id===targetSpace&&t.email===source.email).map(target=>({source:source.id,target:target.id,email:source.email})));
  const report={executable:false as const,sourceSpace,targetSpace,mappings,
   controlProofRequired:mappings.map(m=>m.source),
   unmapped:users.filter(u=>u.space_id===sourceSpace&&!targetBySource.has(u.id)).map(u=>u.id),
   emailConflicts,externalConflicts,
   duplicateFavorites:[...favoriteGroups.values()].filter(group=>group.sources.length>1).map(group=>({...group,action:'deduplicate-only-after-approved-mapping' as const})),
   permissions};
  return report;
 },true);
}
