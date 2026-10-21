import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {directory,item} from '../fixtures/templates/directory.js';
import {renderTemplate,templateManifest,templateCss} from '../src/server/templates.js';
import {css} from '../src/ui/pages.js';
import type {TemplatePage} from '../src/public/sdk.js';
const output=resolve('.local/template-preview');
await mkdir(output+'/assets',{recursive:true});
await writeFile(output+'/assets/network.css',css);await writeFile(output+'/assets/templates.css',templateCss);
const variants:Record<string,TemplatePage>={directory,detail:{...directory,kind:'detail',item,canonical:directory.canonical+'/'+item.slug},missing:{...directory,kind:'missing'},empty:{...directory,kind:'directory',result:{total:0,page:1,limit:20,items:[]},q:'不存在的资源'}};
for(const template of templateManifest)for(const [variant,page] of Object.entries(variants)){
 const html=renderTemplate(template.id,page).replaceAll('href="/assets/','href="./assets/');
 await writeFile(`${output}/${template.id}-${variant}.html`,html);
}
console.log(`Generated ${templateManifest.length*Object.keys(variants).length} previews in ${output}; open locally or serve this directory.`);
