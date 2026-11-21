// dashboard.js — publisher app: upload, analytics, sponsors, embed.
const PDFJS_VER = '4.6.82';
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}`;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const PAL = ['#3987e5','#d95926','#199e70','#c98500','#d55181','#0ca30c','#9085e9','#e66767'];
const fmt = n => n >= 1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : ''+Math.round(n);
const secs = s => s<60 ? Math.round(s)+'s' : Math.floor(s/60)+'m '+Math.round(s%60)+'s';
const pct = n => Math.round(n*100)+'%';

const D = { pubs: [], sel: null, tab: 'analytics', dev: 'all', data: null };

/* ---------- boot ---------- */
(async function(){
  const me = await (await fetch('/api/me')).json();
  if(!me.email){ location.href='/'; return; }
  $('#who').textContent = me.email;
  await loadPubs();
})();

async function loadPubs(){
  D.pubs = await (await fetch('/api/pubs')).json();
  $('#pubCount').textContent = D.pubs.length ? D.pubs.length+'' : '';
  const list = $('#publist');
  if(!D.pubs.length){ list.innerHTML = `<p style="color:var(--muted);padding:12px">No publications yet.</p>`; }
  else list.innerHTML = D.pubs.map(p=>`
    <div class="pubrow${D.sel===p.slug?' active':''}" data-slug="${p.slug}">
      <div class="t">${esc(p.title)}</div>
      <div class="m">${p.numPages} pages · ${fmt(p.sessions)} sessions</div>
    </div>`).join('');
  $$('.pubrow').forEach(r=>r.onclick=()=>selectPub(r.dataset.slug));
  if(D.sel && !D.pubs.find(p=>p.slug===D.sel)) D.sel=null;
  if(!D.sel){ $('#emptyMain').style.display=''; $('#detail').style.display='none'; }
}

async function selectPub(slug){
  D.sel = slug; D.tab='analytics'; D.dev='all';
  $$('.pubrow').forEach(r=>r.classList.toggle('active',r.dataset.slug===slug));
  $('#emptyMain').style.display='none'; $('#detail').style.display='';
  await loadAnalytics();
  renderDetail();
}
async function loadAnalytics(){
  D.data = await (await fetch(`/api/pubs/${D.sel}/analytics?device=${D.dev}`)).json();
}

/* ---------- detail shell ---------- */
function renderDetail(){
  const p = D.data, origin = location.origin;
  const url = `${origin}/r/${D.sel}`;
  $('#detail').innerHTML = `
    <div class="detail-head">
      <h2>${esc(p.title)}</h2>
      <div class="sharebox"><code>${url}</code>
        <button class="btn" id="copyShare">Copy</button>
        <a class="btn" href="${url}" target="_blank" rel="noopener">Open reader ↗</a>
      </div>
      <div class="spacer" style="flex:1"></div>
      <button class="btn danger" id="delPub">Delete</button>
    </div>
    <div class="subtabs">
      <button class="subtab ${D.tab==='analytics'?'on':''}" data-tab="analytics">Analytics</button>
      <button class="subtab ${D.tab==='sponsors'?'on':''}" data-tab="sponsors">Sponsors</button>
      <button class="subtab ${D.tab==='embed'?'on':''}" data-tab="embed">Embed</button>
    </div>
    <div id="tabbody"></div>`;
  $('#copyShare').onclick=()=>copy(url);
  $('#delPub').onclick=()=>delPub();
  $$('.subtab').forEach(b=>b.onclick=()=>{ D.tab=b.dataset.tab; renderDetail(); });
  if(D.tab==='analytics') renderAnalytics();
  if(D.tab==='sponsors') renderSponsors();
  if(D.tab==='embed') renderEmbed(url);
}

/* ---------- analytics ---------- */
function renderAnalytics(){
  const p = D.data, N = p.numPages;
  const body = $('#tabbody');
  const noData = p.sessions===0;
  body.innerHTML = `
    <div class="filters">
      <div class="seg" id="devSeg">
        ${['all','desktop','mobile','tablet'].map(d=>`<button class="${D.dev===d?'on':''}" data-dev="${d}">${d==='all'?'All devices':d}</button>`).join('')}
      </div>
      <div class="spacer" style="flex:1"></div>
      <button class="btn" id="exportCsv">Copy CSV</button>
    </div>
    ${noData?`<div class="panel" style="text-align:center;color:var(--muted);padding:34px">
       No reader data yet. Share the reader link — analytics appear here as people read.
       <div style="margin-top:8px"><a href="/r/${D.sel}" target="_blank" rel="noopener" class="btn">Open the reader yourself to generate a session ↗</a></div></div>`:''}
    <div class="kpis" id="kpis"></div>
    <div class="grid">
      <div class="panel col-7"><h3>Reading funnel — how far readers get</h3>
        <p class="hint">Share of sessions that reached each page. The cliffs are where you lose people.</p><div id="retention"></div></div>
      <div class="panel col-5"><h3>Attention heatmap</h3>
        <p class="hint">Average dwell per page. Brighter = more time.</p><div class="heat" id="heat"></div>
        <div class="legend"><span><span class="swatch" style="background:#1f3147"></span>low</span><span><span class="swatch" style="background:#3987e5"></span>mid</span><span><span class="swatch" style="background:#86b6ef"></span>high</span></div></div>
      <div class="panel col-12"><h3>Time spent per page</h3>
        <p class="hint">Average seconds per page. Tall bars are your most engaging content.</p><div id="dwell"></div></div>
      <div class="panel col-7"><h3>Link performance &amp; click-through</h3>
        <p class="hint">Every clickable link, where it lives, and how often readers who saw it clicked.</p>
        <div style="max-height:320px;overflow:auto"><table id="linkTable"></table></div></div>
      <div class="panel col-5"><h3>Where readers come from</h3>
        <p class="hint">Device mix and top referrers.</p><div id="donut"></div><table id="refTable" style="margin-top:8px"></table></div>
      <div class="panel col-6"><h3>When they read</h3><p class="hint">Opens by hour (reader-local).</p><div id="hours"></div></div>
      <div class="panel col-6"><h3>In-document searches</h3><p class="hint">What readers looked for.</p><table id="searchTable"></table></div>
      <div class="panel col-12"><h3>Automated insights</h3><p class="hint">Plain-language read of the numbers.</p><div id="insights"></div></div>
    </div>`;
  $('#devSeg').addEventListener('click',async e=>{ const b=e.target.closest('button'); if(!b)return;
    D.dev=b.dataset.dev; await loadAnalytics(); renderAnalytics(); });
  $('#exportCsv').onclick=exportCsv;

  const dwellAvg=p.dwellAvg, pv=p.pageViews;
  // KPIs
  const totalClicks=p.links.reduce((a,l)=>a+l.clicks,0), totalImp=p.links.reduce((a,l)=>a+l.imp,0);
  $('#kpis').innerHTML =
    kpi('Reader sessions',fmt(p.sessions),D.dev==='all'?'all devices':D.dev)+
    kpi('Avg. completion',pct(p.completionAvg),p.completionAvg>.6?'readers finish strong':'drop-off before the end',p.completionAvg>.6?'up':'down')+
    kpi('Avg. time in doc',secs(p.durationAvg),'per session')+
    kpi('Link clicks',fmt(totalClicks),'CTR '+pct(totalImp?totalClicks/totalImp:0))+
    kpi('Bounce rate',pct(p.bounce),'left on page 1',p.bounce>.3?'down':'up')+
    kpi('Pages',''+N,p.doublePage?'double-page':'single page');

  renderRetention(pv,N); renderDwell(dwellAvg,N); renderHeat(dwellAvg,N);
  renderDonut(p.devices); renderRefs(p.referrers); renderHours(p.hours);
  renderLinkTable(p.links); renderSearches(p.searches);
  renderInsights(p,N,{totalClicks,totalImp});
}
function kpi(l,v,s,c){ return `<div class="kpi"><div class="lab">${l}</div><div class="val">${v}</div><div class="sub ${c||''}">${s||''}</div></div>`; }

function renderRetention(pv,N){
  const s0=pv[1]||1, data=[]; for(let p=1;p<=N;p++) data.push((pv[p]||0)/s0);
  const W=640,H=230,L=38,R=12,T=12,B=28,iw=W-L-R,ih=H-T-B;
  const x=i=>L+(N>1?i/(N-1)*iw:0), y=v=>T+ih-v*ih;
  let path=''; data.forEach((v,i)=>path+=(i?'L':'M')+x(i)+' '+y(v)+' ');
  const area=path+`L${x(N-1)} ${T+ih} L${x(0)} ${T+ih} Z`;
  let gl=''; [0,.25,.5,.75,1].forEach(v=>gl+=`<line class="gl" x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L-6}" y="${y(v)+3}" text-anchor="end">${Math.round(v*100)}%</text>`);
  let dots=''; data.forEach((v,i)=>dots+=`<circle cx="${x(i)}" cy="${y(v)}" r="8" fill="transparent" data-p="${i+1}" data-v="${v}" class="rdot"/>`);
  let xl=''; for(let i=0;i<N;i+=Math.ceil(N/8)) xl+=`<text class="ax" x="${x(i)}" y="${H-8}" text-anchor="middle">${i+1}</text>`;
  $('#retention').innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="rg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3987e5" stop-opacity=".30"/><stop offset="1" stop-color="#3987e5" stop-opacity="0"/></linearGradient></defs>
    ${gl}<path d="${area}" fill="url(#rg)"/><path d="${path}" fill="none" stroke="#3987e5" stroke-width="2"/>${dots}${xl}</svg>`;
  $$('#retention .rdot').forEach(d=>tip(d,()=>({t:'Page '+d.dataset.p,rows:[['reached',pct(+d.dataset.v)]]})));
}
function renderDwell(dw,N){
  const data=dw.slice(1,N+1), max=Math.max(...data,1), hot=data.indexOf(max);
  const W=980,H=190,L=34,R=8,T=8,B=24,iw=W-L-R,ih=H-T-B,gap=iw/N,bw=gap*.7;
  let bars='',xl=''; data.forEach((v,i)=>{ const h=v/max*ih,px=L+i*gap+(gap-bw)/2,py=T+ih-h,col=i===hot?'#d95926':'#3987e5';
    bars+=`<rect x="${px}" y="${py}" width="${bw}" height="${Math.max(h,1)}" rx="3" fill="${col}" class="dbar" data-p="${i+1}" data-v="${v}"/>`;
    if(i%Math.ceil(N/16)===0) xl+=`<text class="ax" x="${px+bw/2}" y="${H-8}" text-anchor="middle">${i+1}</text>`; });
  let gl=''; [0,.5,1].forEach(f=>{ const yy=T+ih-f*ih; gl+=`<line class="gl" x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}"/><text class="ax" x="${L-6}" y="${yy+3}" text-anchor="end">${Math.round(f*max)}s</text>`; });
  $('#dwell').innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${gl}${bars}${xl}</svg>
    <div class="legend"><span><span class="swatch" style="background:#d95926"></span>most-read page (p${hot+1})</span><span><span class="swatch" style="background:#3987e5"></span>avg dwell</span></div>`;
  $$('#dwell .dbar').forEach(b=>tip(b,()=>({t:'Page '+b.dataset.p,rows:[['avg dwell',secs(+b.dataset.v)]]})));
}
function renderHeat(dw,N){
  const data=dw.slice(1,N+1), vals=data.filter(x=>x>0), max=Math.max(...data,1), min=vals.length?Math.min(...vals):0;
  const cols=Math.min(8,N); $('#heat').style.gridTemplateColumns=`repeat(${cols},1fr)`;
  const blue=t=>{ const lo=[31,49,71],hi=[134,182,239],c=lo.map((l,i)=>Math.round(l+(hi[i]-l)*t)); return `rgb(${c[0]},${c[1]},${c[2]})`; };
  $('#heat').innerHTML=data.map((v,i)=>{ const t=max>min?(v-min)/(max-min):0;
    return `<div class="cell" style="background:${blue(t)}" title="Page ${i+1}: ${secs(v)}">${i+1}</div>`; }).join('');
}
function renderDonut(d){
  const data=[['Desktop',d.desktop,'#3987e5'],['Mobile',d.mobile,'#d95926'],['Tablet',d.tablet,'#199e70']];
  const tot=data.reduce((a,b)=>a+b[1],0)||1; let a0=-Math.PI/2,seg=''; const cx=70,cy=70,r=54,sw=22;
  data.forEach(([l,v,c])=>{ const a1=a0+v/tot*Math.PI*2; const x0=cx+r*Math.cos(a0),y0=cy+r*Math.sin(a0),x1=cx+r*Math.cos(a1),y1=cy+r*Math.sin(a1),lg=(a1-a0)>Math.PI?1:0;
    if(v>0) seg+=`<path d="M${x0} ${y0} A${r} ${r} 0 ${lg} 1 ${x1} ${y1}" fill="none" stroke="${c}" stroke-width="${sw}"/>`; a0=a1; });
  const leg=data.map(([l,v,c])=>`<span><span class="swatch" style="background:${c}"></span>${l} ${pct(v/tot)}</span>`).join('');
  $('#donut').innerHTML=`<div style="display:flex;align-items:center;gap:14px"><svg viewBox="0 0 140 140" width="140" height="140">${seg}
    <text x="70" y="66" text-anchor="middle" fill="var(--ink)" font-size="20" font-weight="700">${fmt(tot)}</text>
    <text x="70" y="84" text-anchor="middle" fill="var(--muted)" font-size="10">sessions</text></svg>
    <div class="legend" style="flex-direction:column;gap:6px">${leg}</div></div>`;
}
function renderRefs(r){
  const rows=Object.entries(r).sort((a,b)=>b[1]-a[1]).slice(0,6), tot=rows.reduce((a,b)=>a+b[1],0)||1;
  $('#refTable').innerHTML=`<tr><th>Referrer</th><th class="num">Sessions</th><th class="num">Share</th></tr>`+
    (rows.length?rows.map(([k,v])=>`<tr><td>${esc(k)}</td><td class="num">${fmt(v)}</td><td class="num">${pct(v/tot)}</td></tr>`).join('')
     :`<tr><td colspan="3" style="color:var(--muted)">—</td></tr>`);
}
function renderHours(h){
  const max=Math.max(...h,1),W=560,H=150,L=28,R=6,T=8,B=22,iw=W-L-R,ih=H-T-B,gap=iw/24,bw=gap*.68;
  let bars='',xl=''; h.forEach((v,i)=>{ const hh=v/max*ih,px=L+i*gap+(gap-bw)/2,py=T+ih-hh;
    bars+=`<rect x="${px}" y="${py}" width="${bw}" height="${Math.max(hh,1)}" rx="2" fill="#9085e9" class="hbar" data-h="${i}" data-v="${v}"/>`;
    if(i%4===0) xl+=`<text class="ax" x="${px+bw/2}" y="${H-7}" text-anchor="middle">${i}:00</text>`; });
  $('#hours').innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%">${bars}${xl}</svg>`;
  $$('#hours .hbar').forEach(b=>tip(b,()=>({t:b.dataset.h+':00',rows:[['sessions',fmt(+b.dataset.v)]]})));
}
function renderLinkTable(links){
  const rows=[...links].sort((a,b)=>b.clicks-a.clicks), maxCtr=Math.max(...rows.map(r=>r.ctr),.001);
  $('#linkTable').innerHTML=`<tr><th>Link</th><th>Page</th><th>Type</th><th class="num">Views</th><th class="num">Clicks</th><th class="num" style="width:120px">CTR</th></tr>`+
    (rows.length?rows.map(r=>`<tr><td>${esc(r.label)}</td><td>${r.page}</td>
      <td>${r.sponsor?`<span class="pill spon">${esc(r.sponsor)}</span>`:'<span class="pill">editorial</span>'}</td>
      <td class="num">${fmt(r.imp)}</td><td class="num">${fmt(r.clicks)}</td>
      <td class="num bar-cell"><span class="fill" style="width:${r.ctr/maxCtr*100}%"></span><span>${pct(r.ctr)}</span></td></tr>`).join('')
     :`<tr><td colspan="6" style="color:var(--muted)">No links detected in this PDF. You can still tag any URL as a sponsor in the Sponsors tab.</td></tr>`);
}
function renderSearches(s){
  $('#searchTable').innerHTML=`<tr><th>Query</th><th class="num">Count</th></tr>`+
    (s.length?s.map(r=>`<tr><td>“${esc(r.q)}”</td><td class="num">${fmt(r.c)}</td></tr>`).join('')
     :`<tr><td colspan="2" style="color:var(--muted)">No searches yet.</td></tr>`);
}
function renderInsights(p,N,m){
  const dw=p.dwellAvg.slice(1,N+1), hot=dw.indexOf(Math.max(...dw))+1;
  let drop=1,dropV=0; for(let q=2;q<=N;q++){ const d=((p.pageViews[q-1]||0)-(p.pageViews[q]||0))/Math.max(1,p.pageViews[1]||1); if(d>dropV){dropV=d;drop=q;} }
  const best=[...p.links].sort((a,b)=>b.clicks-a.clicks)[0];
  const items=[];
  if(p.sessions===0){ $('#insights').innerHTML=`<div class="insight"><div class="k">🌱</div><p>No reader sessions yet — insights appear once people open your reader link.</p></div>`; return; }
  items.push(['🔥',`Page <b>${hot}</b> holds attention longest (${secs(Math.max(...dw))} avg). Put your highest-value message or a premium ad slot here.`]);
  if(dropV>0) items.push(['📉',`Sharpest drop-off is entering page <b>${drop}</b> — about <b>${pct(dropV)}</b> of readers leave there. Shorten the run-up or add a hook.`]);
  items.push(['🏁',`Only <b>${pct(p.completionAvg)}</b> of the document is read on average. ${p.completionAvg<.5?'Front-load the essentials.':'Readers go deep — back-of-book placements have value.'}`]);
  if(best&&best.clicks) items.push(['🔗',`Top link: <b>${esc(best.label)}</b>${best.sponsor?` (${esc(best.sponsor)})`:''} at <b>${pct(best.ctr)}</b> CTR.`]);
  if(p.bounce>.3) items.push(['⚠️',`Bounce is <b>${pct(p.bounce)}</b> — many leave on the cover. Check the first impression your link shows.`]);
  $('#insights').innerHTML=items.map(([k,t])=>`<div class="insight"><div class="k">${k}</div><p>${t}</p></div>`).join('');
}

/* ---------- sponsors ---------- */
function renderSponsors(){
  const p=D.data;
  const tagged=p.links.filter(l=>l.sponsor);
  const map={}; tagged.forEach(l=>{ const s=map[l.sponsor]=map[l.sponsor]||{name:l.sponsor,domain:dom(l.url),pages:[],imp:0,clicks:0,dwell:0,dwellN:0};
    s.pages.push(l.page); s.imp+=l.imp; s.clicks+=l.clicks; s.dwell+=p.dwellAvg[l.page]||0; s.dwellN++; });
  const sp=Object.values(map);
  const body=$('#tabbody');
  body.innerHTML=`
    <div class="filters"><p class="hint" style="margin:0;max-width:640px">
      Tag any link as a sponsor to generate their delivery report — impressions (page views), dwell on the placement, clicks and CTR.</p>
      <div class="spacer" style="flex:1"></div>
      <button class="btn" id="exportSpon">Copy report</button></div>
    <div class="spon-grid" id="sponGrid">${sp.length?sp.map((s,i)=>{ const c=PAL[i%PAL.length],ctr=s.imp?s.clicks/s.imp:0;
      return `<div class="spon-card"><div class="accent" style="background:${c}"></div>
        <h4>${esc(s.name)}</h4><div class="dom">${esc(s.domain)} · page ${[...new Set(s.pages)].join(', ')}</div>
        <div class="metricrow"><span>Impressions (page views)</span><span class="v">${fmt(s.imp)}</span></div>
        <div class="metricrow"><span>Avg. dwell on placement</span><span class="v">${secs(s.dwell/Math.max(1,s.dwellN))}</span></div>
        <div class="metricrow"><span>Clicks</span><span class="v">${fmt(s.clicks)}</span></div>
        <div class="metricrow"><span>Click-through rate</span><span class="v" style="color:${ctr>.05?'var(--good)':'var(--ink)'}">${pct(ctr)}</span></div></div>`; }).join('')
      :`<div class="panel" style="grid-column:1/-1;color:var(--muted)">No sponsors tagged yet. Tag links below.</div>`}</div>
    <div class="panel"><h3>All links — tag a sponsor</h3>
      <p class="hint">Set the advertiser a link belongs to. Blank = editorial.</p>
      <div style="max-height:360px;overflow:auto"><table id="allLinks"></table></div></div>`;
  $('#exportSpon').onclick=exportSponsors;
  const rows=p.links;
  $('#allLinks').innerHTML=`<tr><th>Link</th><th>Page</th><th class="num">Views</th><th class="num">Clicks</th><th>Sponsor</th></tr>`+
    (rows.length?rows.map(l=>`<tr><td title="${esc(l.url)}">${esc(l.label)}</td><td>${l.page}</td>
      <td class="num">${fmt(l.imp)}</td><td class="num">${fmt(l.clicks)}</td>
      <td><input data-id="${l.id}" class="sponIn" value="${esc(l.sponsor||'')}" placeholder="—"
        style="width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;color:var(--ink);padding:5px 8px"></td></tr>`).join('')
     :`<tr><td colspan="5" style="color:var(--muted)">No links in this PDF. (Sponsors need clickable links embedded in the document.)</td></tr>`);
  $$('.sponIn').forEach(inp=>inp.addEventListener('change',async()=>{
    await fetch(`/api/pubs/${D.sel}/links/${inp.dataset.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sponsor:inp.value.trim()||null})});
    await loadAnalytics(); renderSponsors(); toast('Sponsor updated');
  }));
}

/* ---------- embed ---------- */
function renderEmbed(url){
  const slug=D.sel, origin=location.origin;
  $('#tabbody').innerHTML=`
    <div class="panel" style="margin-bottom:16px"><h3>Share link</h3>
      <p class="hint">Send this to readers, or put it behind a QR code in print.</p>
      <pre class="code">${url}</pre><button class="btn" id="c1">Copy link</button></div>
    <div class="panel" style="margin-bottom:16px"><h3>Embed in a web page / iframe</h3>
      <p class="hint">Drop the reader into any site. Events are collected exactly the same way.</p>
      <pre class="code" id="iframeCode">&lt;iframe src="${url}" width="100%" height="720" style="border:0;border-radius:12px" loading="lazy"&gt;&lt;/iframe&gt;</pre>
      <button class="btn" id="c2">Copy embed</button></div>
    <div class="panel"><h3>Event model</h3>
      <p class="hint">Each reader session streams these to <code>${origin}/api/r/${slug}/events</code> via <code>navigator.sendBeacon</code>.</p>
      <pre class="code">POST /api/r/${slug}/events
{ "sid":"&lt;random per reader&gt;",
  "events":[
    { "type":"open", "device":"mobile", "referrer":"instagram.com", "ts":... },
    { "type":"page_enter", "page":7, "ts":... },
    { "type":"page_exit",  "page":7, "dwell_ms":9400, "ts":... },
    { "type":"link_click", "page":7, "link_id":"...", "ts":... },
    { "type":"zoom", "page":7 }, { "type":"search", "query":"price" },
    { "type":"complete", "page":${D.data.numPages} }
  ] }</pre></div>`;
  $('#c1').onclick=()=>copy(url);
  $('#c2').onclick=()=>copy($('#iframeCode').textContent);
}

/* ---------- exports ---------- */
function exportCsv(){
  const p=D.data; let csv='page,views,avg_dwell_s,rereads,zooms\n';
  for(let i=1;i<=p.numPages;i++) csv+=`${i},${p.pageViews[i]||0},${(p.dwellAvg[i]||0).toFixed(1)},${p.reReads[i]||0},${p.zooms[i]||0}\n`;
  csv+='\nlink,page,sponsor,views,clicks,ctr\n';
  p.links.forEach(l=>csv+=`"${l.label}",${l.page},${l.sponsor||''},${l.imp},${l.clicks},${l.ctr.toFixed(3)}\n`);
  copy(csv);
}
function exportSponsors(){
  const p=D.data,map={}; p.links.filter(l=>l.sponsor).forEach(l=>{ const s=map[l.sponsor]=map[l.sponsor]||{n:l.sponsor,d:dom(l.url),pg:[],imp:0,cl:0,dw:0,c:0};
    s.pg.push(l.page); s.imp+=l.imp; s.cl+=l.clicks; s.dw+=p.dwellAvg[l.page]||0; s.c++; });
  let csv='sponsor,domain,pages,impressions,avg_dwell_s,clicks,ctr\n';
  Object.values(map).forEach(s=>csv+=`${s.n},${s.d},"${[...new Set(s.pg)].join(' ')}",${s.imp},${(s.dw/Math.max(1,s.c)).toFixed(1)},${s.cl},${(s.imp?s.cl/s.imp:0).toFixed(3)}\n`);
  copy(csv);
}

/* ---------- upload ---------- */
let upFile=null;
$('#newBtn').onclick=$('#newBtn2').onclick=()=>openModal();
$('#upCancel').onclick=closeModal;
$('#modal').addEventListener('click',e=>{ if(e.target.id==='modal') closeModal(); });
$('#upDrop').onclick=()=>$('#upFile').click();
$('#upFile').onchange=e=>setFile(e.target.files[0]);
['dragover','dragenter'].forEach(ev=>$('#upDrop').addEventListener(ev,e=>{e.preventDefault();$('#upDrop').classList.add('over');}));
['dragleave','drop'].forEach(ev=>$('#upDrop').addEventListener(ev,e=>{e.preventDefault();$('#upDrop').classList.remove('over');}));
$('#upDrop').addEventListener('drop',e=>{ const f=e.dataTransfer.files[0]; if(f) setFile(f); });
function openModal(){ upFile=null; $('#upTitle').value=''; $('#upDropTxt').textContent='Drop a PDF here, or click to choose';
  $('#upGo').disabled=true; $('#upErr').classList.remove('show'); $('#upProg').classList.remove('show'); $('#modal').classList.add('show'); }
function closeModal(){ $('#modal').classList.remove('show'); }
function setFile(f){ if(!f) return;
  if(f.type!=='application/pdf'&&!f.name.toLowerCase().endsWith('.pdf')){ upErr('That is not a PDF.'); return; }
  upFile=f; $('#upDropTxt').textContent='📄 '+f.name; $('#upGo').disabled=false;
  if(!$('#upTitle').value) $('#upTitle').value=f.name.replace(/\.pdf$/i,''); }
function upErr(m){ $('#upErr').textContent=m; $('#upErr').classList.add('show'); }

$('#upGo').onclick=async()=>{
  if(!upFile) return;
  $('#upGo').disabled=true; $('#upErr').classList.remove('show');
  const prog=$('#upProg'); prog.classList.add('show'); const bar=prog.querySelector('i');
  try{
    bar.style.width='15%';
    // parse client-side for page count, aspect, and link annotations
    const pdfjs=await import(`${CDN}/pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc=`${CDN}/pdf.worker.min.mjs`;
    const buf=await upFile.arrayBuffer();
    const doc=await pdfjs.getDocument({data:buf.slice(0)}).promise;
    const numPages=doc.numPages;
    const p1=await doc.getPage(1); const vp=p1.getViewport({scale:1}); const aspect=vp.height/vp.width;
    bar.style.width='40%';
    const links=await extractLinks(doc);
    bar.style.width='55%';
    // upload file
    const fd=new FormData(); fd.append('file',upFile); fd.append('title',$('#upTitle').value.trim()||'Untitled');
    fd.append('numPages',numPages); fd.append('aspect',aspect.toFixed(4));
    fd.append('doublePage',$('#upDouble').classList.contains('on')?'true':'false');
    const res=await fetch('/api/pubs',{method:'POST',body:fd});
    const d=await res.json(); if(!res.ok) throw new Error(d.message||d.error||'upload failed');
    bar.style.width='80%';
    // send links
    await fetch(`/api/pubs/${d.slug}/links`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({links})});
    bar.style.width='100%';
    closeModal(); await loadPubs(); selectPub(d.slug);
    toast('Published — '+numPages+' pages, '+links.length+' links detected');
  }catch(e){ upErr('Could not process this PDF: '+(e.message||e)); $('#upGo').disabled=false; prog.classList.remove('show'); console.error(e); }
};
async function extractLinks(doc){
  const out=[], max=Math.min(doc.numPages,60);
  for(let p=1;p<=max;p++){ try{
    const page=await doc.getPage(p); const vp=page.getViewport({scale:1}); const ann=await page.getAnnotations();
    for(const a of ann){ if(a.subtype==='Link'&&a.url){ const [x1,y1,x2,y2]=a.rect;
      out.push({page:p,url:a.url,label:dom(a.url),
        nx:Math.min(x1,x2)/vp.width, ny:1-Math.max(y1,y2)/vp.height,
        nw:Math.abs(x2-x1)/vp.width, nh:Math.abs(y2-y1)/vp.height}); } }
  }catch(e){ console.warn('links page',p,e); } }
  return out;
}

/* ---------- misc ---------- */
async function delPub(){ if(!confirm('Delete this publication and all its analytics? This cannot be undone.')) return;
  await fetch('/api/pubs/'+D.sel,{method:'DELETE'}); D.sel=null; await loadPubs(); toast('Deleted'); }
$('#logout').onclick=async()=>{ await fetch('/api/auth/logout',{method:'POST'}); location.href='/'; };

const tt=$('#tt');
function tip(el,fn){ el.addEventListener('mousemove',e=>{ const d=fn();
  tt.innerHTML=`<div class="tt-t">${d.t}</div>`+d.rows.map(r=>`<div class="tt-r"><span>${r[0]}</span><span>${r[1]}</span></div>`).join('');
  tt.style.left=Math.min(e.clientX+14,innerWidth-250)+'px'; tt.style.top=(e.clientY+14)+'px'; tt.style.opacity=1; });
  el.addEventListener('mouseleave',()=>tt.style.opacity=0); }
let toastT; function toast(m){ const t=$('#toast'); t.textContent=m; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2200); }
function copy(t){ navigator.clipboard?.writeText(t).then(()=>toast('Copied')).catch(()=>toast('Copy failed')); }
function dom(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return (u||'').slice(0,40); } }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
