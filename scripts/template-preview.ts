import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {category,detail,directory,home} from '../fixtures/templates/directory.js';
import {renderHomeTemplate,renderTemplate,templateHasHome,templateManifest,templateCss} from '../src/server/templates.js';
import {themeCss} from '../src/server/theme.js';
import {css} from '../src/ui/pages.js';
import type {TemplatePage} from '../src/public/sdk.js';
const output=resolve('.local/template-preview');
await mkdir(output+'/assets/fonts',{recursive:true});
await mkdir(output+'/assets/theme',{recursive:true});
await writeFile(output+'/assets/network.css',css);await writeFile(output+'/assets/templates.css',templateCss);
// Template assets served from /assets/ by src/server/http.ts. toolso.css points at /assets/fonts/, which
// becomes relative to the stylesheet so the fonts resolve when the directory is opened from disk.
await writeFile(output+'/assets/toolso.css',(await readFile(resolve('src/ui/generated/toolso.css'),'utf8')).replaceAll('/assets/fonts/','./fonts/'));
for(const font of ['Geist-Variable.woff2','GeistMono-Variable.woff2'])await copyFile(resolve('src/ui/fonts',font),`${output}/assets/fonts/${font}`);
for(const script of ['toolso.js','toolso-init.js','directory.js'])await copyFile(resolve('src/ui',script),`${output}/assets/${script}`);
// Rendered as published pages (preview:false) so the pages reference their scripts; the fixtures keep
// preview:true for draft-preview rendering.
const live=<T extends {preview?:boolean}>(page:T)=>({...page,preview:false});
const variants:Record<string,TemplatePage>={directory,category,detail,missing:{...directory,kind:'missing'},empty:{...directory,kind:'directory',result:{total:0,page:1,limit:20,items:[]},q:'不存在的资源'}};
const themes=new Set<string>();
const relative=(html:string)=>{
 for(const [,hex] of html.matchAll(/\/assets\/theme\/([0-9a-f]{6})\.css/g))themes.add(hex!);
 return html.replace(/(href|src)="\/assets\//g,'$1="./assets/');
};
let count=0;
for(const template of templateManifest){
 const pages:[string,string][]=Object.entries(variants).map(([variant,page])=>[variant,renderTemplate(template.id,live(page))]);
 if(templateHasHome(template.id))pages.push(['home',renderHomeTemplate(template.id,live(home))]);
 for(const [variant,html] of pages){await writeFile(`${output}/${template.id}-${variant}.html`,relative(html));count++;}
}
for(const hex of themes)await writeFile(`${output}/assets/theme/${hex}.css`,themeCss(hex));
console.log(`Generated ${count} previews in ${output}; serve this directory (for example \`npx serve ${output}\`) — module scripts do not run from file://.`);
