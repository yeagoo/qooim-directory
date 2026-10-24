import {defineTemplate,escapeHtml} from '../public/sdk.js';
import {renderClassic,type ClassicLayout} from './classic.js';
const supports={alternatives:true,comparisons:true};
const layout:ClassicLayout={layout:'basic',
 intro:page=>`<section class="directory-intro"><span class="eyebrow">${escapeHtml(page.site.templateParams?.eyebrow??'INDEPENDENT FINDS, SHARED CURIOSITY')}</span><h1>${escapeHtml(page.site.name)}</h1><p class="muted">${escapeHtml(page.site.tagline)}</p><nav>${page.site.locales.map(l=>`<a href="/${l}/${escapeHtml(page.catalogPath)}" ${l===page.locale?'aria-current="page"':''}>${l==='zh'?'中文':'English'}</a>`).join(' · ')}</nav></section>`,
 list:(_page,items,card)=>`<section class="directory-list">${items.map(card).join('')}</section>`,
 empty:'<section class="directory-list"><p class="empty">还没有匹配的资源，换个关键词再看看。</p></section>',
 missing:page=>`<section class="resource-detail"><h1>这个语言的内容暂不可用。</h1><nav>${page.alternates.map(a=>`<a href="${escapeHtml(a.url)}">${a.locale==='zh'?'查看中文':'View English'}</a>`).join(' · ')}</nav><p><a href="/">返回目录</a></p></section>`};
export default defineTemplate({id:'basic',apiVersion:1,supports,render:page=>renderClassic(page,layout,supports)});
