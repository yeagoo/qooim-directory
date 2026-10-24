/** AI-authored example. Reviewed source, API v1; imports only the public SDK and the shared classic renderer. */
import {defineTemplate,escapeHtml} from '../public/sdk.js';
import {renderClassic,type ClassicLayout} from './classic.js';
const supports={alternatives:true,comparisons:true};
const layout:ClassicLayout={layout:'editorial',
 intro:page=>`<section class="editorial-masthead"><span class="eyebrow">${escapeHtml(page.site.templateParams?.eyebrow??'A NOTEBOOK OF USEFUL DISCOVERIES')}</span><h1>${escapeHtml(page.site.name)}</h1><div class="editorial-deck"><p>${escapeHtml(page.site.tagline)}</p><nav>${page.site.locales.map(l=>`<a href="/${l}/${escapeHtml(page.catalogPath)}">${l==='zh'?'中文':'English'}</a>`).join(' / ')}</nav></div></section>`,
 list:(page,items,card)=>`<section class="editorial-index">${items.map((item,i)=>`<div class="editorial-entry"><span class="entry-number">${String((page.result.page-1)*page.result.limit+i+1).padStart(2,'0')}</span>${card(item)}</div>`).join('')}</section>`,
 empty:'<section class="editorial-index"><p class="empty">目录还在生长。试试另一个关键词。</p></section>',
 missing:page=>`<section class="resource-detail"><p class="eyebrow">THE READING ROOM</p><h1>这一页，尚待书写。</h1><p>该语言内容暂不可用。</p>${page.alternates.map(a=>`<a href="${escapeHtml(a.url)}">${a.locale==='zh'?'查看中文':'View English'}</a>`).join(' · ')}<p><a href="/">返回目录</a></p></section>`};
export default defineTemplate({id:'editorial',apiVersion:1,supports,render:page=>renderClassic(page,layout,supports)});
