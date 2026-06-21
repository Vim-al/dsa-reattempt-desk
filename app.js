/* =========================================================================
   The Reattempt Desk — app logic
   State model: records keyed by problem name.
   record = { done, gate:'pass'|'fail', conf:1-5, time:int|null,
              note:str, lastAt:ISO, dueAt:ISO|null, attempts:int,
              history:[ {at:ISO, gate, conf, time, note} ] }
   history holds one entry per logged attempt (oldest first); the top-level
   gate/conf/time/note mirror the most recent entry for rendering + metrics.
   Re-attempt rule: miss the 25-min gate -> dueAt = today + 3 days.
   Pass -> light spaced check at +14 days. Cleared when re-passed.
   ========================================================================= */

const GATE_MISS_DAYS = 3;
const GATE_PASS_DAYS = 14;
const GATE_MINUTES   = 25;   // the unassisted solve-time gate
const DATA = window.NEETCODE_150;
const CFG  = window.TRACKER_CONFIG || {};
const KEY  = "reattempt_desk_v1";

let state = {};           // { [problemName]: record }
let sb = null;            // supabase client (if configured)
let modalTarget = null;   // { name, pattern }

/* ---------- leetcode links ----------
   Most names slugify cleanly; these few have LeetCode slugs that differ. */
const LC_SLUG_OVERRIDE = {
  "Two Sum II": "two-sum-ii-input-array-is-sorted",
  "Lowest Common Ancestor of a BST": "lowest-common-ancestor-of-a-binary-search-tree",
  "Construct Binary Tree from Preorder and Inorder": "construct-binary-tree-from-preorder-and-inorder-traversal",
  "Number of Connected Components": "number-of-connected-components-in-an-undirected-graph",
  "Merge Triplets to Form Target": "merge-triplets-to-form-target-triplet",
  "Pow(x, n)": "powx-n",
};
function leetcodeURL(name){
  const slug = LC_SLUG_OVERRIDE[name] ||
    name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return `https://leetcode.com/problems/${slug}/`;
}
/* NeetCode publishes a solution walkthrough video for every problem. Its site
   uses bespoke slugs that don't map cleanly from the name, so route to a
   YouTube search scoped to the channel — reliably surfaces the exact video. */
function neetcodeURL(name){
  return `https://www.youtube.com/results?search_query=${encodeURIComponent('NeetCode ' + name)}`;
}

/* inline brand marks (currentColor so CSS sets the tint) */
const LC_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M13.483 0a1.374 1.374 0 0 0-.961.438L7.116 6.226l-3.854 4.126a5.266 5.266 0 0 0-1.209 2.104 5.35 5.35 0 0 0-.125.513 5.527 5.527 0 0 0 .062 2.362 5.83 5.83 0 0 0 .349 1.017 5.938 5.938 0 0 0 1.271 1.818l4.277 4.193.039.038c2.248 2.165 5.852 2.133 8.063-.074l2.396-2.392c.54-.54.54-1.414.003-1.955a1.378 1.378 0 0 0-1.951-.003l-2.396 2.392a3.021 3.021 0 0 1-4.205.038l-.02-.019-4.276-4.193c-.652-.64-.972-1.469-.948-2.263a2.68 2.68 0 0 1 .066-.523 2.545 2.545 0 0 1 .619-1.164L9.13 8.114c1.058-1.134 3.204-1.27 4.43-.278l3.501 2.831c.593.48 1.461.387 1.94-.207a1.384 1.384 0 0 0-.207-1.943l-3.5-2.831c-.8-.647-1.766-1.045-2.774-1.202l2.015-2.158A1.384 1.384 0 0 0 13.483 0zm-2.866 12.815a1.38 1.38 0 0 0-1.38 1.382 1.38 1.38 0 0 0 1.38 1.382H20.79a1.38 1.38 0 0 0 1.38-1.382 1.38 1.38 0 0 0-1.38-1.382z"/></svg>`;
const NC_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5.5" fill="currentColor"/><path d="M10 8.2l6 3.8-6 3.8z" fill="#08110d"/></svg>`;

/* ---------- date helpers ----------
   All dates are local-calendar ISO (YYYY-MM-DD). Mixing UTC (toISOString) with
   local parsing shifts dueAt by a day in non-UTC zones — e.g. IST surfaced
   every re-attempt a day early — so format from local fields throughout. */
const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const todayISO = () => fmtLocal(new Date());
function addDays(iso, n){ const d = new Date(iso+"T00:00:00"); d.setDate(d.getDate()+n); return fmtLocal(d); }
function daysBetween(a,b){ return Math.round((new Date(b+"T00:00:00")-new Date(a+"T00:00:00"))/86400000); }
function isDue(rec){ return rec && rec.dueAt && rec.dueAt <= todayISO(); }

/* ---------- supabase (optional) ---------- */
async function initSupabase(){
  if(!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return false;
  try{
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    return true;
  }catch(e){ console.warn("Supabase init failed, using local:", e); sb=null; return false; }
}
function loadScript(src){
  return new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src;
    s.onload=res; s.onerror=rej; document.head.appendChild(s); });
}

async function loadState(){
  if(sb){
    try{
      const { data, error } = await sb.from('attempts').select('*');
      if(error) throw error;
      state = {};
      (data||[]).forEach(r=>{ state[r.problem] = {
        done:r.done, gate:r.gate, conf:r.conf, time:r.time, note:r.note||"",
        lastAt:r.last_at, dueAt:r.due_at, attempts:r.attempts||1,
        history:Array.isArray(r.history)?r.history:[] }; });
      setSync('live'); return;
    }catch(e){ console.warn("Supabase read failed, local fallback:", e); sb=null; }
  }
  const raw = localStorage.getItem(KEY);
  state = raw ? JSON.parse(raw) : {};
  setSync(sb ? 'live' : 'local');
}

async function persist(name){
  localStorage.setItem(KEY, JSON.stringify(state)); // always keep a local mirror
  if(sb){
    const r = state[name];
    try{
      await sb.from('attempts').upsert({
        problem:name, done:r.done, gate:r.gate, conf:r.conf, time:r.time,
        note:r.note, last_at:r.lastAt, due_at:r.dueAt, attempts:r.attempts,
        history:r.history||[]
      }, { onConflict:'problem' });
    }catch(e){ console.warn("Supabase write failed (saved locally):", e); }
  }
}

/* ---------- metrics ---------- */
function metrics(){
  const today = todayISO();
  let solved=0, gatePass=0, gateLogged=0, dueNow=0, overdue=0, total=0, nextDue=null;
  DATA.forEach(p=>p.problems.forEach(([nm])=>{
    total++; const r=state[nm];
    if(r&&r.done){ solved++; gateLogged++; if(r.gate==='pass') gatePass++; }
    if(isDue(r)){ dueNow++; if(r.dueAt < today) overdue++; }
    else if(r && r.dueAt && r.dueAt > today && (!nextDue || r.dueAt < nextDue)){ nextDue = r.dueAt; }
  }));
  const rate = gateLogged ? Math.round(gatePass/gateLogged*100) : 0;
  const nextInDays = nextDue ? daysBetween(today, nextDue) : null;
  return { solved, total, rate, gateLogged, dueNow, overdue, nextDue, nextInDays };
}

/* ---------- render: metric strip ---------- */
function renderStrip(){
  const m = metrics();
  const pct = Math.round(m.solved/m.total*100);
  const gateWarn = m.gateLogged>=5 && m.rate<70;
  // The re-attempt queue already shows what's due *now*; this tile earns its keep
  // by answering the question the queue can't when it's empty — "when's the next
  // one, and am I behind?" — instead of echoing the queue count.
  let dueTile;
  if(m.dueNow){
    dueTile = `<div class="metric">
      <div class="k">Due now</div>
      <div class="v" style="color:var(--sell)">${m.dueNow}</div>
      <div class="sub">${m.overdue?`${m.overdue} overdue`:'none overdue'}</div>
    </div>`;
  } else if(m.nextInDays!=null){
    dueTile = `<div class="metric">
      <div class="k">Next resurfaces</div>
      <div class="v">${m.nextInDays===0?'today':`${m.nextInDays}<small>d</small>`}</div>
      <div class="sub">${m.nextDue}</div>
    </div>`;
  } else {
    dueTile = `<div class="metric">
      <div class="k">Re-attempts</div>
      <div class="v" style="color:var(--ink3)">—</div>
      <div class="sub">none scheduled</div>
    </div>`;
  }
  document.getElementById('strip').innerHTML = `
    <div class="metric">
      <div class="k">Solved</div>
      <div class="v">${m.solved}<small>/${m.total}</small></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>
    <div class="metric gate ${gateWarn?'warn':''}">
      <div class="k">25-min gate pass</div>
      <div class="v">${m.rate}<small>%</small></div>
      <div class="bar"><span style="width:${m.rate}%"></span></div>
    </div>
    ${dueTile}
    <div class="metric">
      <div class="k">Logged attempts</div>
      <div class="v">${m.gateLogged}</div>
    </div>`;
}

/* ---------- render: due queue ---------- */
function renderQueue(){
  const due = [];
  DATA.forEach(p=>p.problems.forEach(([nm])=>{
    const r=state[nm];
    if(isDue(r)) due.push({ name:nm, pattern:p.pattern, over:daysBetween(r.dueAt, todayISO()) });
  }));
  due.sort((a,b)=>b.over-a.over);
  document.getElementById('dueCt').textContent = due.length ? `${due.length} queued` : '';
  const mount = document.getElementById('queueMount');
  if(!due.length){
    mount.innerHTML = `<div class="queue empty">
      <div class="qhead"><span class="pulse"></span><span class="qt">Re-attempt queue</span><span class="qn">clear</span></div>
      <div class="qempty"><b>Nothing due.</b> Log a missed problem and it resurfaces here in 3 days.</div>
    </div>`;
    return;
  }
  mount.innerHTML = `<div class="queue">
    <div class="qhead"><span class="pulse"></span><span class="qt">Re-attempt queue</span><span class="qn">${due.length} due</span></div>
    ${due.map(d=>`<div class="qrow" onclick="openModal('${esc(d.name)}','${esc(d.pattern)}')">
      <span class="pat">${d.pattern}</span>
      <span class="nm">${d.name}</span>
      <span class="od">${d.over===0?'due today':'+'+d.over+'d late'}</span>
      <span class="go">re-attempt →</span>
    </div>`).join('')}
  </div>`;
}

/* ---------- render: pattern accordions ---------- */
function renderPatterns(){
  const m = metrics();
  document.getElementById('patCt').textContent = `${m.solved}/${m.total} solved`;
  const mount = document.getElementById('patMount');
  mount.innerHTML = DATA.map((p,i)=>{
    const tot=p.problems.length;
    const done=p.problems.filter(([nm])=>state[nm]&&state[nm].done).length;
    const frac=done/tot, circ=2*Math.PI*12, off=circ*(1-frac);
    const open = openState[p.pattern] ? 'open' : '';
    return `<div class="pat-card ${open}" data-pat="${esc(p.pattern)}">
      <div class="pat-top" onclick="togglePat('${esc(p.pattern)}')">
        <span class="pat-wk">WK ${p.week}</span>
        <span class="pat-nm">${p.pattern}</span>
        <span class="pat-stat">${done}/${tot}</span>
        <svg class="pat-ring" width="30" height="30" viewBox="0 0 30 30">
          <circle class="bg" cx="15" cy="15" r="12"></circle>
          <circle class="fg" cx="15" cy="15" r="12"
            stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
        </svg>
        <span class="chev">▶</span>
      </div>
      <div class="pat-body">
        ${p.problems.map(([nm,df])=>rowHTML(nm,df,p.pattern)).join('')}
      </div>
    </div>`;
  }).join('');
}

function rowHTML(nm,df,pat){
  const r = state[nm] || {};
  const done = r.done;
  const confColor = r.conf ? (r.conf<=2?'lo':r.conf===3?'mid':'') : '';
  const confBars = [1,2,3,4,5].map(n=>`<i class="${confColor} ${r.conf>=n?'on':''}"></i>`).join('');
  let meta = '';
  if(done){
    const tag = r.gate==='pass'
      ? '<span class="gate-tag gate-pass">≤25m</span>'
      : '<span class="gate-tag gate-fail">missed</span>';
    meta = `${tag}<div class="conf" title="confidence">${confBars}</div>` +
           (r.time?`<span>${r.time}m</span>`:'') +
           (r.attempts>1?`<span class="att" title="${r.attempts} logged attempts">×${r.attempts}</span>`:'');
  }
  return `<div class="prow ${done?'done':''}" data-nm="${esc(nm)}">
    <span class="dot-diff d-${df}" title="${df==='E'?'Easy':df==='M'?'Medium':'Hard'}"></span>
    <span class="pn">
      <span class="txt" onclick="openModal('${esc(nm)}','${esc(pat)}')">${nm}</span>
      <span class="links">
        <a class="ext-link lc" href="${leetcodeURL(nm)}" target="_blank" rel="noopener"
           title="Open on LeetCode" onclick="event.stopPropagation()">${LC_ICON}</a>
        <a class="ext-link nc" href="${neetcodeURL(nm)}" target="_blank" rel="noopener"
           title="Watch NeetCode solution" onclick="event.stopPropagation()">${NC_ICON}</a>
      </span>
    </span>
    <span class="meta">${meta}<span class="log-btn" onclick="openModal('${esc(nm)}','${esc(pat)}')">${done?'edit':'log'}</span></span>
  </div>`;
}

/* ---------- accordion state ---------- */
let openState = {};
function togglePat(p){ openState[p]=!openState[p]; renderPatterns(); }
function expandAll(v){ DATA.forEach(p=>openState[p.pattern]=v); renderPatterns(); }

/* ---------- log modal ---------- */
let mGate='pass', mConf=3;
function openModal(name,pattern){
  modalTarget={name,pattern};
  const r=state[name]||{};
  mGate = r.gate || 'pass';
  mConf = r.conf || 3;
  document.getElementById('mPat').textContent=pattern;
  document.getElementById('mName').textContent=name;
  document.getElementById('mTime').value=r.time||'';
  document.getElementById('mNote').value=r.note||'';
  renderHistory(r);
  syncSegs();
  updateNextHint();
  document.getElementById('scrim').classList.add('show');
}
/* ---------- version history (inside the log modal) ---------- */
function escHTML(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderHistory(r){
  const fld=document.getElementById('histFld');
  const list=document.getElementById('histList');
  let hist=(r&&Array.isArray(r.history))?r.history:[];
  // Display-time backfill: a problem logged before history existed has no
  // history array yet (it gets persisted on the next real save). Synthesize
  // its existing attempt as v1 so the section is visible right away.
  if(!hist.length && r && r.done){
    hist=[{ at:r.lastAt||todayISO(), gate:r.gate, conf:r.conf,
            time:(r.time??null), note:r.note||'' }];
  }
  if(!hist.length){ fld.style.display='none'; list.innerHTML=''; return; }
  fld.style.display='block';
  document.getElementById('histCt').textContent =
    hist.length+(hist.length>1?' versions':' version');
  // newest first; number them oldest=v1 so the progression reads naturally
  list.innerHTML = hist.map((h,i)=>({h,v:i+1})).reverse().map(({h,v})=>{
    const gate = h.gate==='pass'
      ? '<span class="hgate gate-pass">≤25m</span>'
      : '<span class="hgate gate-fail">missed</span>';
    const conf = h.conf ? '●'.repeat(h.conf)+'○'.repeat(5-h.conf) : '○○○○○';
    const time = h.time!=null ? ` · ${h.time}m` : '';
    const note = h.note
      ? `<div class="hnote">${escHTML(h.note)}</div>`
      : `<div class="hnote empty">no notes</div>`;
    return `<div class="hv">
      <div class="hvh">
        <span class="hv-n">v${v}</span>${gate}
        <span class="when">${h.at}${time}</span>
        <span class="v-conf" title="confidence ${h.conf||'–'}/5">${conf}</span>
      </div>
      ${note}
    </div>`;
  }).join('');
}
function closeModal(){ document.getElementById('scrim').classList.remove('show'); modalTarget=null; }
function syncSegs(){
  document.querySelectorAll('#gateSeg button').forEach(b=>{
    b.classList.toggle('sel', b.dataset.g===mGate);
  });
  document.querySelectorAll('#confPick button').forEach(b=>{
    b.classList.toggle('sel', +b.dataset.c===mConf);
  });
}
function updateNextHint(){
  const h=document.getElementById('nextHint');
  if(mGate==='fail'){
    h.innerHTML=`↻ Resurfaces in the queue on <b style="color:var(--sell)">${addDays(todayISO(),GATE_MISS_DAYS)}</b> (+${GATE_MISS_DAYS} days).`;
  }else{
    h.innerHTML=`✓ Cleared. Light spaced check on ${addDays(todayISO(),GATE_PASS_DAYS)}.`;
  }
}
document.addEventListener('click',e=>{
  const g=e.target.closest('#gateSeg button');
  if(g){ mGate=g.dataset.g; syncSegs(); updateNextHint(); }
  const c=e.target.closest('#confPick button');
  if(c){ mConf=+c.dataset.c; syncSegs(); }
});
document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') closeModal(); });
// typing a solve time drives the 25-min gate so it can never disagree with the clock
document.getElementById('mTime').addEventListener('input',e=>{
  const t=parseInt(e.target.value,10);
  if(isNaN(t)) return;
  mGate = t > GATE_MINUTES ? 'fail' : 'pass';
  syncSegs(); updateNextHint();
});

async function saveLog(){
  if(!modalTarget) return;
  const nm=modalTarget.name;
  const t=parseInt(document.getElementById('mTime').value);
  // a recorded solve time is the source of truth for the 25-min gate
  if(!isNaN(t)) mGate = t > GATE_MINUTES ? 'fail' : 'pass';
  const noteVal=document.getElementById('mNote').value.trim();
  const prev=state[nm]||{};

  // Build the version history. Every save is a new, immutable version — the
  // log is an append-only record of attempts. Records logged before history
  // existed get backfilled so their already-completed attempt isn't lost.
  let history=Array.isArray(prev.history)?prev.history.slice():[];
  if(!history.length && prev.done){
    history.push({ at:prev.lastAt||todayISO(), gate:prev.gate, conf:prev.conf,
                   time:prev.time??null, note:prev.note||'' });
  }
  history.push({ at:todayISO(), gate:mGate, conf:mConf, time:isNaN(t)?null:t, note:noteVal });

  const rec={
    done:true, gate:mGate, conf:mConf,
    time:isNaN(t)?null:t,
    note:noteVal,
    lastAt:todayISO(),
    dueAt: mGate==='fail' ? addDays(todayISO(),GATE_MISS_DAYS) : addDays(todayISO(),GATE_PASS_DAYS),
    attempts:history.length,
    history
  };
  state[nm]=rec;
  await persist(nm);
  closeModal();
  renderAll();
  toast(mGate==='fail' ? `Logged · resurfaces in ${GATE_MISS_DAYS} days` : 'Logged · gate cleared ✓');
}

/* ---------- export / import ---------- */
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`reattempt-desk-${todayISO()}.json`; a.click();
  toast('Exported JSON');
}
function importData(ev){
  const f=ev.target.files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=async()=>{
    try{
      const incoming=JSON.parse(rd.result);
      Object.assign(state,incoming);
      localStorage.setItem(KEY,JSON.stringify(state));
      if(sb){ for(const nm of Object.keys(incoming)) await persist(nm); }
      renderAll(); toast('Imported ✓');
    }catch(e){ toast('Import failed — bad file'); }
  };
  rd.readAsText(f);
  ev.target.value='';
}

/* ---------- misc ---------- */
function esc(s){ return String(s).replace(/'/g,"\\'").replace(/"/g,'&quot;'); }
function setSync(mode){
  const b=document.getElementById('syncBadge'), t=document.getElementById('syncTxt');
  b.className='sync '+mode;
  t.textContent = mode==='live'?'Synced':'Local';
  document.getElementById('setupBanner').style.display = mode==='live'?'none':'flex';
}
let toastTimer;
function toast(msg){
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2200);
}
function clock(){
  const d=new Date();
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('clkDay').textContent=days[d.getDay()];
  document.getElementById('clkDate').textContent=fmtLocal(d);
}

function renderAll(){ renderStrip(); renderQueue(); renderPatterns(); }

/* ---------- boot ---------- */
(async function(){
  clock(); setInterval(clock,60000);
  // open the first incomplete pattern by default
  const firstOpen = DATA.find(p=>p.problems.some(([nm])=>!(state[nm]&&state[nm].done)));
  await initSupabase();
  await loadState();
  if(firstOpen) openState[firstOpen.pattern]=true; else openState[DATA[0].pattern]=true;
  renderAll();
})();
