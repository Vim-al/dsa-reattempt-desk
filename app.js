/* =========================================================================
   The Reattempt Desk — app logic
   State model: records keyed by problem name.
   record = { done, gate:'pass'|'fail', conf:1-5, time:int|null,
              note:str, lastAt:ISO, dueAt:ISO|null, attempts:int }
   Re-attempt rule: miss the 25-min gate -> dueAt = today + 3 days.
   Pass -> light spaced check at +14 days. Cleared when re-passed.
   ========================================================================= */

const GATE_MISS_DAYS = 3;
const GATE_PASS_DAYS = 14;
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

/* ---------- date helpers ---------- */
const todayISO = () => new Date().toISOString().slice(0,10);
function addDays(iso, n){ const d = new Date(iso+"T00:00:00"); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function daysBetween(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }
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
        lastAt:r.last_at, dueAt:r.due_at, attempts:r.attempts||1 }; });
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
        note:r.note, last_at:r.lastAt, due_at:r.dueAt, attempts:r.attempts
      }, { onConflict:'problem' });
    }catch(e){ console.warn("Supabase write failed (saved locally):", e); }
  }
}

/* ---------- metrics ---------- */
function metrics(){
  let solved=0, gatePass=0, gateLogged=0, dueNow=0, total=0;
  DATA.forEach(p=>p.problems.forEach(([nm])=>{
    total++; const r=state[nm];
    if(r&&r.done){ solved++; gateLogged++; if(r.gate==='pass') gatePass++; }
    if(isDue(r)) dueNow++;
  }));
  const rate = gateLogged ? Math.round(gatePass/gateLogged*100) : 0;
  return { solved, total, rate, gateLogged, dueNow };
}

/* ---------- render: metric strip ---------- */
function renderStrip(){
  const m = metrics();
  const pct = Math.round(m.solved/m.total*100);
  const gateWarn = m.gateLogged>=5 && m.rate<70;
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
    <div class="metric">
      <div class="k">Due today</div>
      <div class="v" style="${m.dueNow?'color:var(--sell)':''}">${m.dueNow}</div>
      <div class="bar"><span style="width:${m.dueNow?100:0}%;background:var(--sell)"></span></div>
    </div>
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
           (r.time?`<span>${r.time}m</span>`:'');
  }
  return `<div class="prow ${done?'done':''}" data-nm="${esc(nm)}">
    <span class="dot-diff d-${df}" title="${df==='E'?'Easy':df==='M'?'Medium':'Hard'}"></span>
    <span class="pn" onclick="openModal('${esc(nm)}','${esc(pat)}')">
      <span class="txt">${nm}</span>
      <a class="lc-link" href="${leetcodeURL(nm)}" target="_blank" rel="noopener"
         title="Open on LeetCode" onclick="event.stopPropagation()">↗</a>
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
  syncSegs();
  updateNextHint();
  document.getElementById('scrim').classList.add('show');
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

async function saveLog(){
  if(!modalTarget) return;
  const nm=modalTarget.name;
  const t=parseInt(document.getElementById('mTime').value);
  const prev=state[nm]||{attempts:0};
  const rec={
    done:true, gate:mGate, conf:mConf,
    time:isNaN(t)?null:t,
    note:document.getElementById('mNote').value.trim(),
    lastAt:todayISO(),
    dueAt: mGate==='fail' ? addDays(todayISO(),GATE_MISS_DAYS) : addDays(todayISO(),GATE_PASS_DAYS),
    attempts:(prev.attempts||0)+1
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
  document.getElementById('clkDate').textContent=d.toISOString().slice(0,10);
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
