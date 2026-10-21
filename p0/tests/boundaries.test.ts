import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
test('R06: direct and indirect DB imports and environment access fail the architecture gate',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'navigation-boundary-'));
 try{
  for(const d of ['templates','public','helpers','internal'])await mkdir(join(dir,d));
  await writeFile(join(dir,'public/sdk.ts'),'export type Item = string;');
  await writeFile(join(dir,'helpers/escape.ts'),"import '../internal/db.js';");
  for(const source of ["import '../internal/db.js';","import '../helpers/escape.js';","export const x=process.env.SECRET;","const p=globalThis['process'];","import('pg');"]){
   await writeFile(join(dir,'templates/basic.ts'),source);
   assert.throws(()=>execFileSync(process.execPath,['scripts/check-boundaries.mjs',dir],{stdio:'pipe'}));
  }
  await writeFile(join(dir,'templates/basic.ts'),"import type {Item} from '../public/sdk.js';");
  execFileSync(process.execPath,['scripts/check-boundaries.mjs',dir]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
