export function escape(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export const css = `
@media(max-width:600px){.github-sources table{min-width:340px}.github-sources button{white-space:nowrap}}
.sidebar,.panel,.split>div,fieldset{min-width:0}
.project-facts{font:12px/1.8 ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}.submission-image{max-width:160px;max-height:160px;object-fit:contain;border-radius:6px}fieldset{border:1px solid var(--line);margin-top:18px}
.account-layout{max-width:1040px;margin:8vh auto;display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);background:white;min-height:620px}.account-story{background:#e8ecdf;padding:48px;display:flex;flex-direction:column;justify-content:center}.account-story .brand{margin-bottom:70px;text-decoration:none}.account-story h1{font-size:54px;line-height:1.15}.account-story .eyebrow{color:var(--muted)}.account-form{padding:48px}.account-form h2{font-size:34px;margin-top:42px}.provider-list{border-top:1px solid var(--line);padding-top:16px}.provider-list button{display:block;width:100%;margin:10px 0}.linked-list{border-top:1px solid var(--line);margin:20px 0}.linked-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:13px 0;border-bottom:1px solid var(--line)}.linked-row strong{font-weight:600}.linked-row .muted{font-size:13px}@media(max-width:720px){.account-layout{display:block;margin:18px;min-height:0}.account-story{padding:28px}.account-story .brand{margin-bottom:24px}.account-story h1{font-size:36px}.account-form{padding:28px}.account-form h2{margin-top:24px}}

.directory-intro{padding:60px 0 24px}.directory-intro h1{font-size:56px}.search{border-top:1px solid var(--line);padding:18px 0}.search .row{flex-wrap:nowrap}.search input{flex:1;min-width:0}.search select{width:auto;max-width:180px}.result-label{font:12px/2 monospace;color:var(--muted);margin:16px 0}.directory-list{border-top:2px solid var(--ink)}.directory-item{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:26px 0;border-bottom:1px solid var(--line)}.directory-item>div{min-width:0}.directory-item p{white-space:pre-wrap;overflow-wrap:anywhere}.item-title{font-family:Georgia,serif;font-size:26px;text-decoration:none}.favorite{flex-shrink:0}.resource-detail{padding:65px 0;max-width:800px}.resource-detail h1{font-size:52px}.detail-description{font-size:19px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere}.pagination{display:flex;gap:14px;margin-top:24px}.empty{padding:40px 0}.button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}@media(max-width:600px){.directory-intro h1,.resource-detail h1{font-size:36px}.search .row{flex-wrap:wrap}.search input{flex-basis:100%}.directory-item{gap:12px}.item-title{font-size:22px}.public header{gap:18px;flex-wrap:wrap}.panel{padding:20px}}
:root{--ink:#20312e;--muted:#697873;--paper:#f5f4ef;--line:#d9ded7;--accent:#286747;--warm:#e8ecdf}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 "Avenir Next","PingFang SC","Microsoft Yahei",sans-serif}a{color:inherit}button,input,textarea,select{font:inherit}button,.button{background:var(--accent);color:white;border:1px solid var(--accent);padding:9px 18px;border-radius:5px;cursor:pointer;text-decoration:none;display:inline-block}button:hover{filter:brightness(.92)}button:disabled{opacity:.5;cursor:wait}button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}input,textarea,select{width:100%;padding:10px 12px;border:1px solid #bfc9bf;border-radius:4px;background:#fff;color:var(--ink)}input[type=checkbox]{width:auto;margin-right:8px}label:has(input[type=checkbox]){display:flex;align-items:center}input:focus,textarea:focus,button:focus-visible{outline:2px solid #56895e;outline-offset:3px}textarea{min-height:220px;font:13px/1.7 ui-monospace,monospace;resize:vertical}label{display:block;font-weight:600;margin:16px 0 7px}h1,h2,h3{font-family:"Iowan Old Style","Songti SC",Georgia,serif;font-weight:500;letter-spacing:-.035em}h1{font-size:40px;line-height:1.2;margin:8px 0 20px}h2{font-size:26px;margin:0 0 18px}p{margin:10px 0}small,.muted{color:var(--muted)}.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}.sidebar{background:#e8ecdf;padding:32px 24px;border-right:1px solid var(--line)}.brand{font-family:Georgia,serif;font-size:25px;letter-spacing:-1px}.brand span{display:block;font:10px/2 monospace;letter-spacing:3px;color:var(--muted)}.sidebar nav{margin-top:45px}.sidebar a{display:block;padding:10px 12px;margin:3px 0;border-radius:4px;text-decoration:none}.sidebar a.active,.sidebar a:hover{background:#d7dfce}.content{min-width:0;max-width:1240px;width:100%;padding:36px 54px 70px;margin:auto}.topline{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:35px;gap:20px}.eyebrow{font:11px/1.6 monospace;letter-spacing:2px;text-transform:uppercase}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:26px 0}.site-card{background:#fff;padding:26px;border:1px solid var(--line);border-top:3px solid var(--accent);text-decoration:none;display:block}.site-card h2{margin:16px 0 10px}.badge{font-size:12px;padding:3px 9px;background:var(--warm);border-radius:20px}.panel{background:#fff;border:1px solid var(--line);padding:26px;margin-top:24px}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.row>*{flex:0 1 auto}.split{display:grid;grid-template-columns:1fr 1fr;gap:24px}.actions{margin:22px 0;display:flex;gap:10px;flex-wrap:wrap}.notice{padding:12px 16px;margin:16px 0;border-left:3px solid var(--accent);background:#e8f0e5;white-space:pre-wrap}.notice:empty{display:none}.notice.error{border-color:#a34c35;background:#f5e8df}table{width:100%;border-collapse:collapse;text-align:left}.table-wrap code{overflow-wrap:anywhere}th,td{padding:13px 10px;border-bottom:1px solid var(--line);font-size:14px}th{font-weight:500;color:var(--muted)}.table-wrap{overflow:auto}pre{overflow:auto;white-space:pre-wrap;font-size:12px}details{margin:18px 0}summary{cursor:pointer;color:var(--accent)}.login{max-width:430px;margin:10vh auto;background:white;border:1px solid var(--line);padding:40px}.public{max-width:1000px;margin:auto;padding:42px 28px}.public header{display:flex;align-items:center;justify-content:space-between;padding:18px 0;border-bottom:1px solid var(--line)}.hero{padding:70px 0 35px;max-width:720px}.hero h1{font-size:62px}.resource{padding:22px 0;border-bottom:1px solid var(--line);display:block;text-decoration:none}.resource strong{font-size:20px}.footer{padding-top:50px;font-size:12px;color:var(--muted)}[hidden]{display:none!important}@media(max-width:850px){.shell{grid-template-columns:1fr}.sidebar{padding:18px 24px}.sidebar nav{margin-top:12px;display:flex;overflow:auto}.sidebar a{white-space:nowrap}.brand span{display:inline;margin-left:12px}.content{padding:25px}.grid,.split{grid-template-columns:1fr}.hero h1{font-size:40px}.topline{align-items:flex-start;flex-wrap:wrap}.row{overflow-wrap:anywhere}.login{margin:5vh 18px}}@media(prefers-reduced-motion:no-preference){.site-card{transition:transform .15s}.site-card:hover{transform:translateY(-3px)}}
/* Console theme: a quiet light workspace beside a deep navy rail. */
:root{--ink:#141b2d;--muted:#5f6b82;--paper:#f3f5f9;--surface:#fff;--line:#e2e6ef;--line-strong:#cdd3e0;--accent:#2f5bea;--accent-ink:#fff;--accent-soft:#e8eeff;--warm:#eef1f7;--rail:#0f1629;--rail-ink:#c4cde0;--rail-dim:#7d89a3;--ok:#1f8a5b;--ok-soft:#e5f5ee;--danger:#c2412d;--danger-soft:#fbece8;--shadow:0 1px 2px rgba(20,27,45,.06),0 4px 16px rgba(20,27,45,.04);color-scheme:light}
@media(prefers-color-scheme:dark){:root{--ink:#e6eaf3;--muted:#96a0b5;--paper:#0b1020;--surface:#131a2c;--line:#232d45;--line-strong:#33405e;--accent:#7c9bff;--accent-ink:#0b1020;--accent-soft:#1b2546;--warm:#1a2238;--rail:#070b16;--rail-ink:#c4cde0;--rail-dim:#6f7a93;--ok:#4fc796;--ok-soft:#12291f;--danger:#ff8a73;--danger-soft:#2c1712;--shadow:none;color-scheme:dark}}
body{font:14.5px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft Yahei",sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:inherit;font-weight:650;letter-spacing:-.02em;color:var(--ink)}h1{font-size:30px;line-height:1.25;margin:6px 0 10px}h2{font-size:18px;margin:0 0 14px}h3{font-size:15px}
a{color:var(--accent)}.site-card,.resource,.sidebar a,.brand,.item-title{color:inherit}
.eyebrow{font:500 12.5px/1.6 inherit;font-family:inherit;letter-spacing:0;text-transform:none;color:var(--muted)}
code,pre,.project-facts{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
button,.button{background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent);padding:8px 16px;border-radius:8px;font-weight:550;line-height:1.4;transition:background-color .15s,border-color .15s,box-shadow .15s}
button:hover{filter:none;box-shadow:0 0 0 3px var(--accent-soft)}
button.secondary,.button.secondary{background:var(--surface);color:var(--ink);border-color:var(--line-strong)}button.secondary:hover{border-color:var(--accent);box-shadow:none;color:var(--accent)}
button:disabled{opacity:.45;box-shadow:none}
input,textarea,select{border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);padding:9px 12px;transition:border-color .15s,box-shadow .15s}
input:hover,textarea:hover,select:hover{border-color:var(--muted)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
textarea{background:var(--paper)}
label{font-weight:550;font-size:13.5px;margin:14px 0 6px}
.shell{background:var(--paper)}@media(min-width:851px){.shell{grid-template-columns:248px 1fr}}
.sidebar{background:var(--rail);color:var(--rail-ink);border-right:0;padding:28px 16px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
.brand{font:700 17px/1.3 inherit;font-family:inherit;letter-spacing:-.01em;color:#fff;padding:0 12px;white-space:nowrap}
.brand span{font:500 12px/1.6 inherit;font-family:inherit;letter-spacing:0;color:var(--rail-dim);margin-top:4px}
.sidebar nav{margin-top:32px;display:flex;flex-direction:column;gap:2px}
.sidebar a{position:relative;padding:9px 12px;margin:0;border-radius:8px;color:var(--rail-ink);font-weight:500;transition:background-color .15s,color .15s}
.sidebar a:hover{background:rgba(255,255,255,.06);color:#fff}
.sidebar a.active,.sidebar a[aria-current=page]{background:rgba(124,155,255,.16);color:#fff}
.sidebar a[aria-current=page]::before{content:"";position:absolute;left:-16px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:#7c9bff}
.sidebar .footer{margin-top:auto;padding:0 12px;color:var(--rail-dim);font-size:12px}
.content{padding:28px 44px 64px}
.topline{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:28px}
.grid{gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.site-card{background:var(--surface);border:1px solid var(--line);border-top:1px solid var(--line);border-radius:12px;padding:22px;box-shadow:var(--shadow);transition:border-color .15s,box-shadow .15s}
.site-card:hover{border-color:var(--accent);transform:none}
.site-card h2{margin:14px 0 6px;font-size:18px}
.badge{display:inline-block;font-size:12px;font-weight:550;padding:2px 10px;background:var(--accent-soft);color:var(--accent);border-radius:999px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px;margin-top:20px;box-shadow:var(--shadow)}
.panel>h2:first-child{padding-bottom:12px;border-bottom:1px solid var(--line);margin-bottom:16px}
.notice{border:1px solid color-mix(in srgb,var(--ok) 30%,transparent);border-left:3px solid var(--ok);background:var(--ok-soft);border-radius:8px;color:var(--ink)}
.notice:empty{display:none}.notice.error{border-color:color-mix(in srgb,var(--danger) 30%,transparent);border-left-color:var(--danger);background:var(--danger-soft)}
.table-wrap{border:1px solid var(--line);border-radius:10px}
th{background:var(--warm);font-size:12.5px;font-weight:600;color:var(--muted);position:sticky;top:0}
th,td{padding:11px 14px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}tbody tr:hover td{background:color-mix(in srgb,var(--accent-soft) 45%,transparent)}
pre{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:12px}pre:empty{display:none}
summary{color:var(--accent);font-weight:550}
fieldset{border-radius:10px}
.login{max-width:400px;margin:12vh auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:36px;box-shadow:0 12px 40px rgba(20,27,45,.08)}
.login h1{font-size:26px}.login .actions button{width:100%;padding:10px}
.account-layout{background:var(--surface);border-radius:16px;overflow:hidden}.account-story{background:var(--rail);color:var(--rail-ink)}.account-story h1,.account-story .brand{color:#fff}
.footer{color:var(--muted)}.footer a{color:var(--muted)}body>.footer{text-align:center;padding:28px 16px}
@media(max-width:850px){.shell{display:block}.sidebar{position:static;height:auto;padding:14px 16px}.sidebar nav{margin-top:10px;flex-direction:row}.sidebar a[aria-current=page]::before{display:none}.sidebar .footer{display:none}.content{padding:20px 16px 48px}.login{margin:6vh 16px;padding:28px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
:where(:not(.actions,.row))>button+button{margin-left:8px}
textarea.short{min-height:96px}.badge.stale{background:var(--danger-soft);color:var(--danger)}label+small,input+small,select+small,textarea+small{display:block;color:var(--muted);margin-top:4px}
/* Monochrome console (scheme 3): black/white, hairline borders, Geist. */
@font-face{font-family:Geist;src:url(/assets/fonts/Geist-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}@font-face{font-family:"Geist Mono";src:url(/assets/fonts/GeistMono-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
.console{--ink:#0a0a0a;--muted:#666;--paper:#fafafa;--surface:#fff;--line:#eaeaea;--line-strong:#d4d4d4;--accent:#0a0a0a;--accent-ink:#fff;--accent-soft:#f2f2f2;--warm:#fafafa;--ok:#1a7f45;--ok-soft:#e8f6ee;--danger:#d9342b;--danger-soft:#fdeceb;--info:#0068d6;--info-soft:#e9f2fe;--warn:#a35200;--warn-soft:#fff4e0;--idle:#666;--idle-soft:#f2f2f2;--shadow:none;--mono:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace;color-scheme:light}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .console{--ink:#ededed;--muted:#a1a1a1;--paper:#000;--surface:#0a0a0a;--line:#262626;--line-strong:#3a3a3a;--accent:#ededed;--accent-ink:#0a0a0a;--accent-soft:#1a1a1a;--warm:#111;--ok:#4cc38a;--ok-soft:#0f2a1c;--danger:#ff6b61;--danger-soft:#2c1210;--info:#52a8ff;--info-soft:#0d2240;--warn:#f5b54a;--warn-soft:#2e2008;--idle:#a1a1a1;--idle-soft:#1a1a1a;color-scheme:dark}}
:root[data-theme=dark] .console{--ink:#ededed;--muted:#a1a1a1;--paper:#000;--surface:#0a0a0a;--line:#262626;--line-strong:#3a3a3a;--accent:#ededed;--accent-ink:#0a0a0a;--accent-soft:#1a1a1a;--warm:#111;--ok:#4cc38a;--ok-soft:#0f2a1c;--danger:#ff6b61;--danger-soft:#2c1210;--info:#52a8ff;--info-soft:#0d2240;--warn:#f5b54a;--warn-soft:#2e2008;--idle:#a1a1a1;--idle-soft:#1a1a1a;color-scheme:dark}
body.console{background:var(--paper);font:14px/1.6 Geist,ui-sans-serif,-apple-system,"PingFang SC","Noto Sans SC","Microsoft Yahei",sans-serif}
.console h1{font-size:28px;font-weight:600;letter-spacing:-.03em}.console h2{font-size:16px;font-weight:600;letter-spacing:-.01em}
.console code,.console pre,.console kbd,.console .project-facts,.console .mono,.console td.num{font-family:var(--mono)}.console td,.console th,.console .num{font-variant-numeric:tabular-nums}
.console a{color:var(--ink)}.console a:hover{opacity:.75}
.console button,.console .button{background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent);border-radius:6px;padding:7px 14px;font-weight:500}
.console button:hover{box-shadow:none;opacity:.85}.console button.secondary,.console .button.secondary{background:var(--surface);color:var(--ink);border-color:var(--line-strong)}.console button.secondary:hover{border-color:var(--ink);color:var(--ink)}
.console button:active{transform:translateY(1px)}
.console input,.console textarea,.console select{border-color:var(--line-strong);border-radius:6px}.console input:focus,.console textarea:focus,.console select:focus{border-color:var(--ink);box-shadow:0 0 0 3px var(--accent-soft)}.console button:focus-visible,.console a:focus-visible,.console summary:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.shell{display:block;min-height:100vh;background:var(--paper)}@media(min-width:851px){.shell{display:block}}
.topbar{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--line);padding:0 32px}
.topbar-row{height:60px;display:flex;align-items:center;gap:16px}
.topbar .brand{display:flex;align-items:center;gap:12px;font:inherit;color:var(--ink);padding:0;text-decoration:none;white-space:nowrap}.topbar .brand b{font-weight:600}.topbar .sep{color:var(--line-strong);font-size:20px}
.pill{font:12px/1.5 var(--mono);border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}
.topbar-tools{margin-left:auto;display:flex;align-items:center;gap:10px}
.console .search-entry{display:flex;align-items:center;gap:12px;width:280px;height:34px;background:var(--surface);color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:0 10px;font-weight:400;text-align:left}.console .search-entry:hover{border-color:var(--line-strong);opacity:1}
kbd{margin-left:auto;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}
.topbar-tools .button{height:34px;display:inline-flex;align-items:center}
.menu{position:relative}.menu summary{list-style:none;cursor:pointer;height:34px;display:flex;align-items:center;padding:0 10px;border:1px solid var(--line);border-radius:6px;color:var(--ink);font-weight:400}.menu summary::-webkit-details-marker{display:none}.menu summary::after{content:"▾";margin-left:8px;color:var(--muted)}
.menu-panel{position:absolute;right:0;top:40px;min-width:220px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:10px}
.theme-choice{border:0;margin:0;padding:0}.theme-choice legend{font-size:12px;color:var(--muted);padding:0;margin-bottom:4px}.theme-choice label{font-weight:400;margin:4px 0}.theme-choice input{width:auto;margin-right:8px}
.tabs{display:flex;gap:24px;overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tabs a{padding:10px 0 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap}.tabs a:hover{color:var(--ink);opacity:1}.tabs a[aria-current=page]{color:var(--ink);border-bottom-color:var(--ink)}
.content{max-width:1280px;padding:32px 32px 72px}
.console .eyebrow{font-size:13px;color:var(--muted)}
.console .panel{border-radius:12px;border-color:var(--line);box-shadow:none;background:var(--surface)}.console .panel>h2:first-child{border-bottom-color:var(--line)}
.console .table-wrap{border-color:var(--line);border-radius:8px;background:var(--surface);max-height:70vh}
.console th{background:var(--warm);font-size:12px;font-weight:500;color:var(--muted);position:sticky;top:0;z-index:1}.console tbody tr:hover td{background:var(--warm)}
.console .badge{background:var(--idle-soft);color:var(--ink);border-radius:999px;font-weight:500}.console .badge.stale{background:var(--warn-soft);color:var(--warn)}
.status{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 8px;border-radius:999px;background:var(--idle-soft);color:var(--idle)}.status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.status.ok{background:var(--ok-soft);color:var(--ok)}.status.run{background:var(--info-soft);color:var(--info)}.status.review{background:var(--warn-soft);color:var(--warn)}.status.fail{background:var(--danger-soft);color:var(--danger)}
.console .notice{border:1px solid var(--line);border-left:3px solid var(--ok);background:var(--surface)}.console .notice.error{border-left-color:var(--danger);background:var(--danger-soft)}
.overview{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px;align-items:start}
.overview-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}.overview-head h1{margin:0}.overview-head .row{margin-left:auto}
.site-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.site-card{display:flex;flex-direction:column;gap:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:20px;box-shadow:none;text-decoration:none;color:var(--ink)}.site-card:hover{border-color:var(--ink);opacity:1}
.site-card .who{display:flex;align-items:center;gap:12px}.avatar{width:32px;height:32px;flex-shrink:0;border-radius:50%;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:600}
.site-card .host{font:12px var(--mono);color:var(--muted)}.site-card .counts{display:flex;gap:22px;font:12px var(--mono);color:var(--muted)}.site-card .counts b{font:600 18px Geist,ui-sans-serif,sans-serif;color:var(--ink);margin-right:4px}
.site-card .last{border-top:1px solid var(--line);padding-top:12px;color:var(--muted);font-size:13px}.site-card h2{margin:0;font-size:15px}
.activity{border:1px solid var(--line);border-radius:12px;background:var(--surface)}.activity h2{padding:14px 16px;margin:0;border-bottom:1px solid var(--line)}
.activity li{display:flex;gap:10px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--line)}.activity li:last-child{border-bottom:0}.activity ul{list-style:none;margin:0;padding:0}.activity .dot{width:8px;height:8px;border-radius:50%;background:var(--ink);flex-shrink:0}.activity time{margin-left:auto;font:11px var(--mono);color:var(--muted);white-space:nowrap}.activity .text{min-width:0;overflow-wrap:anywhere}
.empty-state{border:1px dashed var(--line-strong);border-radius:12px;padding:32px;text-align:center;color:var(--muted)}.empty-state strong{display:block;color:var(--ink);font-size:15px;margin-bottom:6px}.empty-state .actions{justify-content:center}
.skeleton-page{display:flex;flex-direction:column;gap:14px}.skeleton-page span,.skeleton{display:block;height:18px;border-radius:6px;background:linear-gradient(90deg,var(--accent-soft),var(--line),var(--accent-soft));background-size:200% 100%;animation:shimmer 1.2s infinite}.skeleton-page span:first-child{width:30%;height:28px}.skeleton-page span:nth-child(2){width:60%}.skeleton-page span:nth-child(3){height:160px}
@keyframes shimmer{to{background-position:-200% 0}}
dialog#cmdk{width:min(560px,calc(100vw - 32px));margin-top:12vh;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);box-shadow:0 20px 60px rgba(0,0,0,.25)}dialog#cmdk::backdrop{background:rgba(0,0,0,.35)}
#cmdk-input{border:0;border-bottom:1px solid var(--line);border-radius:0;padding:16px;font-size:15px;box-shadow:none}#cmdk-list{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}#cmdk-list li{padding:9px 12px;border-radius:6px;cursor:pointer;display:flex;gap:10px}#cmdk-list li small{margin-left:auto;color:var(--muted);font-family:var(--mono)}#cmdk-list li[aria-selected=true]{background:var(--accent-soft)}.cmdk-hint{margin:0;padding:8px 14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.login{max-width:380px;margin:14vh auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:32px;box-shadow:none}.login-brand{display:flex;align-items:center;gap:10px;margin-bottom:28px}.login h1{font-size:24px;margin-bottom:4px}
@media(max-width:850px){.topbar{padding:0 16px}.console .search-entry{width:auto}.search-entry kbd,.topbar .pill,.topbar-tools .button{display:none}.content{padding:20px 16px 48px}.overview,.site-grid{grid-template-columns:1fr}.tabs{gap:18px}}
@media(max-width:520px){.console .search-entry{width:34px;padding:0;justify-content:center;font-size:0}.console .search-entry::before{content:"⌕";font-size:16px}.topbar .brand b,.topbar .sep{display:none}}
@media(prefers-reduced-motion:reduce){.skeleton-page span,.skeleton{animation:none}}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.meter{width:100%}.media-thumb{width:100%;max-height:180px;object-fit:cover;border-radius:6px}.media-thumb.contain{max-height:140px;object-fit:contain}.pre-wrap{white-space:pre-wrap}td.alert{color:var(--danger);font-weight:600}body.console button.danger,body.console button.secondary.danger{background:var(--danger);border-color:var(--danger);color:#fff}.activity .actor{font-size:12px}.noscript{margin:0;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--danger-soft);color:var(--danger);text-align:center}`;
export function document(
  title: string,
  body: string,
  script?: string,
  head = "",
  lang = "zh-CN",
  bodyClass = "",
) {
  return `<!doctype html><html lang="${escape(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>${escape(title)}</title>${head}<link rel="stylesheet" href="/assets/network.css"></head><body${bodyClass ? ` class="${escape(bodyClass)}"` : ""}>${body}<footer class="footer" aria-label="Source"><a href="/source.tar.gz">获取本部署源码 · AGPL-3.0</a></footer>${script ? `<script type="module" src="${script}"></script>` : ""}</body></html>`;
}
export function staticPage(
  siteName: string,
  page: { title: string; content: string; locale: string },
  canonical: string,
  alternates: { locale: string; url: string }[],
) {
  const description = Array.from(
    page.content.replace(/[*_`[\]()>#|]/g, "").replace(/\s+/g, " ").trim(),
  )
    .slice(0, 160)
    .join("");
  const paragraphs = page.content
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const head = `<meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(canonical)}"><meta property="og:title" content="${escape(page.title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(canonical)}">${alternates.map((alternate) => `<link rel="alternate" hreflang="${escape(alternate.locale)}" href="${escape(alternate.url)}">`).join("")}`;
  return document(
    page.title + " · " + siteName,
    `<main class="public"><header><a class="brand" href="/">${escape(siteName)}</a><nav><a href="/">返回目录</a></nav></header><article class="resource-detail"><h1>${escape(page.title)}</h1>${paragraphs}</article></main>`,
    undefined,
    head,
    page.locale === "zh" ? "zh-CN" : "en",
  );
}
const logo = `<svg class="logo" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 22 21H2Z" fill="currentColor"></path></svg>`;
const ADMIN_HEAD = '<script src="/assets/admin-theme-init.js"></script>';
export function adminPage() {
  return document(
    "站群工作台",
    `<noscript><p class="noscript">工作台需要启用 JavaScript 才能使用。请在浏览器中允许本站脚本后刷新页面。</p></noscript><div class="shell"><header class="topbar"><div class="topbar-row"><a class="brand" href="/admin">${logo}<span class="sep" aria-hidden="true">/</span><b>Qoo.IM 站群</b><span class="pill">运营者</span></a><div class="topbar-tools"><button type="button" class="search-entry" id="cmdk-open" aria-haspopup="dialog">搜索站点、条目、页面…<kbd>⌘K</kbd></button><a class="button" href="/admin#distribute">统一分发</a><details class="menu" id="account-menu"><summary><span id="account" class="muted"></span><span class="visually-hidden">：账号与外观</span></summary><div class="menu-panel"><fieldset class="theme-choice"><legend>外观</legend><label><input type="radio" name="theme" value="system">跟随系统</label><label><input type="radio" name="theme" value="light">浅色</label><label><input type="radio" name="theme" value="dark">深色</label></fieldset><button class="secondary" id="logout">退出登录</button></div></details></div></div><nav id="nav" class="tabs" aria-label="主导航"><a href="/admin">总览</a><a href="/admin#resources">资源主档</a><a href="/admin#distribute">统一分发</a><a href="/admin#github">开源项目</a><a href="/admin#team">成员权限</a><a href="/admin#tasks">运行任务</a><a href="/admin#audit">审计日志</a></nav></header><main class="content"><div id="message" role="status" aria-live="polite"></div><div id="workspace"><div class="skeleton-page" aria-label="正在加载"><span></span><span></span><span></span></div></div></main><dialog id="cmdk" aria-label="命令面板"><input id="cmdk-input" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="搜索页面、站点或资源" placeholder="跳转到页面、站点，或输入资源标识…" autocomplete="off" aria-controls="cmdk-list"><ul id="cmdk-list" role="listbox" aria-label="搜索结果"></ul><p class="cmdk-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</p></dialog></div>`,
    "/assets/admin.js",
    ADMIN_HEAD,
    "zh-CN",
    "console",
  );
}
export function adminLogin() {
  return document(
    "登录工作台",
    `<noscript><p class="noscript">工作台需要启用 JavaScript 才能使用。请在浏览器中允许本站脚本后刷新页面。</p></noscript><main class="login"><div class="login-brand">${logo}<b>Qoo.IM 站群</b></div><h1>登录工作台</h1><p class="muted">使用运营者账号继续管理你的站点。</p><form id="operator-login"><label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><div class="actions"><button>登录</button></div></form><div id="message" role="status"></div></main>`,
    "/assets/admin.js",
    ADMIN_HEAD,
    "zh-CN",
    "console",
  );
}
export function accountPage(
  name: string,
  shared: boolean,
  path: string,
  options: {
    mail: boolean;
    requireEmail: boolean;
    providers: { id: string; label: string; kind: string }[];
  },
) {
  const mode =
    path === "/forgot-password"
      ? "forgot"
      : path === "/reset-password"
        ? "reset"
        : "login";
  const title =
    mode === "forgot"
      ? "找回密码"
      : mode === "reset"
        ? "设置新密码"
        : "登录你的账号";
  const data = JSON.stringify({ ...options, shared, mode }).replace(
    /</g,
    "\\u003c",
  );
  return document(
    title + " · " + name,
    `<main class="account-layout"><aside class="account-story"><a class="brand" href="/">${escape(name)}</a><span class="eyebrow">YOUR OWN CORNER OF THE WEB</span><h1>留住发现，<br>分享方向。</h1><p>一个账号，继续你在本站的收藏与探索。</p></aside><section class="account-form"><a href="/">← 返回 ${escape(name)}</a><h2>${title}</h2><p class="muted">${shared ? "通过账号中心安全登录。" : mode === "forgot" ? "输入注册邮箱，我们会发送重置链接。" : mode === "reset" ? "设置至少 12 位的新密码。" : "欢迎回来，也欢迎第一次相遇。"}</p><form id="public-login" data-shared="${shared}">${!shared && mode !== "reset" ? '<label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="username" required>' : ""}${!shared && mode !== "forgot" ? `<label for="password">${mode === "reset" ? "新密码" : "密码"}</label><input id="password" name="password" type="password" autocomplete="${mode === "reset" ? "new-password" : "current-password"}" minlength="12" maxlength="128" required>` : ""}<div class="actions"><button>${shared ? "前往账号中心" : mode === "forgot" ? "发送重置邮件" : mode === "reset" ? "保存新密码" : "登录"}</button>${mode === "login" && !shared ? '<button type="button" class="secondary" id="register">注册</button>' : ""}</div></form>${mode === "login" && !shared && options.mail ? '<div class="actions"><a href="/forgot-password">忘记密码？</a><button class="secondary" id="resend">重发验证邮件</button></div>' : ""}${mode === "login" && !shared && options.providers.length ? `<div class="provider-list"><p class="muted">或使用以下账号继续</p>${options.providers.map((p) => `<button class="secondary" data-provider="${escape(p.id)}">通过 ${escape(p.label)} 登录</button>`).join("")}</div>` : ""}${mode !== "login" ? '<a href="/login">返回登录</a>' : ""}<div id="message" role="status" aria-live="polite"></div><script id="account-options" type="application/json">${data}</script>${!shared && mode === "login" ? '<div class="provider-list"><button type="button" class="secondary" id="passkey-login" hidden>使用 Passkey 登录</button></div><script src="/assets/simplewebauthn.js"></script>' : ""}</section></main>`,
    "/assets/account.js",
    '<meta name="robots" content="noindex,nofollow">',
  );
}
export function accountHomePage(
  name: string,
  email: string,
  providers: { id: string; label: string; kind: string }[],
) {
  const data = JSON.stringify({ email, providers }).replace(/</g, "\\u003c");
  return document(
    "账号设置",
    `<main class="account-layout"><aside class="account-story"><a class="brand" href="/">${escape(name)}</a><span class="eyebrow">YOUR ACCOUNT</span><h1>你的账号，<br>由你掌握。</h1><p>管理登录方式，保留你在本站的收藏与探索。</p></aside><section class="account-form"><a href="/">← 返回 ${escape(name)}</a><h2>账号设置</h2><p class="muted">${escape(email)}</p><div id="linked-accounts"><p class="muted">正在加载登录方式…</p></div><div id="link-providers"></div><div id="passkey-section"><h3>Passkey</h3><div id="passkeys"><p class="muted">正在加载 Passkey…</p></div><label for="passkey-name">Passkey 名称</label><input id="passkey-name" maxlength="60" placeholder="例如：MacBook"><div class="actions"><button type="button" class="secondary" id="add-passkey">添加 Passkey</button></div></div><p class="muted">解除最后一个登录方式会被拒绝。绑定后可使用对应平台登录同一账号。</p><div id="message" role="status" aria-live="polite"></div><script id="account-home-data" type="application/json">${data}</script><script src="/assets/simplewebauthn.js"></script></section></main>`,
    "/assets/account-home.js",
    '<meta name="robots" content="noindex,nofollow">',
  );
}
export function publicPage(
  site: {
    id: string;
    revision: number;
    config: {
      name: string;
      tagline?: string;
      navigation: { label: string; href: string }[];
    };
  },
  items: { title: string; slug: string; locale: string }[],
  preview = false,
) {
  return document(
    site.config.name,
    `<main class="public"><header><strong>${escape(site.config.name)}</strong><nav>${site.config.navigation.map((n) => `<a href="${escape(n.href)}">${escape(n.label)}</a>`).join(" · ")} <a href="/login">账号</a></nav></header>${preview ? '<p class="notice">草稿预览 · 尚未发布</p>' : ""}<section class="hero"><span class="eyebrow">A CURATED DIRECTORY / ${escape(site.id)}</span><h1>${escape(site.config.name)}</h1><p class="muted">${escape(site.config.tagline)}</p></section><section>${items.length ? items.map((i) => `<article class="resource"><strong>${escape(i.title)}</strong><p class="muted">${escape(i.locale)} · ${escape(i.slug)}</p></article>`).join("") : '<div class="panel"><h2>一个新的起点</h2><p class="muted">站点已准备就绪，内容将陆续发布。</p></div>'}</section><footer class="footer">独立运营，共享发现。 · 修订 ${site.revision}</footer></main>`,
  );
}
