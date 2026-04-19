const express = require('express');
const fetch   = require('node-fetch');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ═══════════════════════════════════════════
   COMPTES
═══════════════════════════════════════════ */
const accounts = {};
let nextId = 1;

function mkAccount(id) {
  return {
    id, label: `Compte ${id}`,
    yapson: { url:'https://sms-mirror-production.up.railway.app', username:'', password:'', token:'' },
    mgmt:   { url:'https://my-managment.com', username:'', password:'', cookies:[] },
    browser:null, page:null,
    status:'stopped', running:false, loopTimer:null,
    logs:[], ST:{ok:0,miss:0,fix:0,polls:0,sms:0,rej:0},
    seen:new Set(), confirmedIds:new Set(), rejectedIds:new Set(),
    lastTs:Date.now(),
    cfg:{ fonction:'F2', interval:15, senders:'Wave Business,+454,MobileMoney,MoovMoney',
          f2ConfMin:10, f2RejOn:false, f2RejMin:15 },
  };
}

const PORT = parseInt(process.env.PORT||'8080');

/* ═══ Helpers ═══ */
function log(acc, msg, level='INFO') {
  const e = {ts:new Date().toISOString(), level, msg:String(msg)};
  acc.logs.unshift(e);
  if(acc.logs.length>300) acc.logs.pop();
  console.log(`[${acc.id}][${level}] ${msg}`);
}

/* ═══════════════════════════════════════════
   PARSEURS SMS — identiques à YapsonBot
═══════════════════════════════════════════ */
const na = s => (s==null?'':String(s)).trim().replace(/[\s\u00a0]/g,'');
function parseAmt(raw){
  if(!raw)return 0;
  let s=na(raw);
  if(/^[0-9]+\.[0-9]{3}$/.test(s))return parseInt(s.replace('.',''));
  if(/^[0-9]+,[0-9]{3}$/.test(s))return parseInt(s.replace(',',''));
  return Math.floor(parseFloat(s.replace(',','.'))||0);
}
function parseSMS(sender, content) {
  if(!content||typeof content!=='string')return null;
  let m;
  if(sender==='Wave Business'){
    m=content.match(/\((0[0-9]{9})\)\s+a\s+pay[eé]\s+([0-9.,\s\u00a0]+)F/i);
    if(!m)return null; const a=parseAmt(m[2]); return a>0?{phone:m[1],amount:a}:null;
  }
  if(sender==='MobileMoney'){
    m=content.match(/recu\s+([0-9.,\s\u00a0]+)\s*FCFA\s+du\s+\+225\s+(0[0-9]{9})/i);
    if(!m)return null; const a=parseAmt(m[1]); return a>0?{phone:m[2],amount:a}:null;
  }
  if(sender==='MoovMoney'){
    m=content.match(/num[eé]ro\s+\+225\s+(0[0-9]{9})\s+a\s+envoy[eé]\s+([0-9.,\s\u00a0]+)\s*FCFA/i);
    if(!m)return null; const a=parseAmt(m[2]); return a>0?{phone:m[1],amount:a}:null;
  }
  if(sender==='+454'){
    m=content.match(/transfert\s+de\s+([0-9.,\s\u00a0]+)\s*FCFA\s+du\s+(0[0-9]{9})/i);
    if(!m)return null; const a=parseAmt(m[1]); return a>0?{phone:m[2],amount:a}:null;
  }
  return null;
}
function parseProcTime(text){
  if(!text)return 0; let t=0;
  const h=text.match(/([0-9]+)\s*heure/), m=text.match(/([0-9]+)\s*minute/);
  if(h)t+=parseInt(h[1])*60; if(m)t+=parseInt(m[1]);
  if(text.includes('less than')||text.includes('moins'))t=0;
  return t;
}
const fmtAmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g,' ');

/* ═══════════════════════════════════════════
   YAPSONPRESS API — identique à YapsonBot
═══════════════════════════════════════════ */
async function loginYapson(acc) {
  const {url,username,password}=acc.yapson;
  if(!username||!password){log(acc,'⚠️ Identifiants YapsonPress manquants','WARN');return false;}
  log(acc,`Connexion YapsonPress (${username})…`);
  try{
    const r=await fetch(`${url}/api/login`,{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,password})});
    const d=await r.json();
    if(!r.ok||!d.token){log(acc,`❌ Login YapsonPress échoué: ${d.error||r.status}`,'ERROR');return false;}
    acc.yapson.token=d.token;
    log(acc,`✅ YapsonPress connecté (${username})`,'OK');
    return true;
  }catch(e){log(acc,'❌ Erreur YapsonPress: '+e.message,'ERROR');return false;}
}

async function apiFetch(acc, sender) {
  const doFetch = ()=>fetch(
    `${acc.yapson.url}/api/messages?sender=${encodeURIComponent(sender)}&limit=500`,
    {headers:{Authorization:`Bearer ${acc.yapson.token}`}});
  let r=await doFetch();
  if(r.status===401){log(acc,'Token expiré — reconnexion…','WARN');await loginYapson(acc);r=await doFetch();}
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
}

async function apiApprove(acc, id) {
  const doApprove=()=>fetch(
    `${acc.yapson.url}/api/messages/${encodeURIComponent(id)}/status`,
    {method:'PATCH',headers:{Authorization:`Bearer ${acc.yapson.token}`,'Content-Type':'application/json'},
     body:JSON.stringify({status:'approuve'})});
  let r=await doApprove();
  if(r.status===401){await loginYapson(acc);r=await doApprove();}
  return r.ok;
}

async function findPhone(acc, phone) {
  const senders=acc.cfg.senders.split(',').map(s=>s.trim());
  const suffix=phone.replace(/[^0-9]/g,'').slice(-9);
  for(const s of senders){
    try{
      const msgs=await apiFetch(acc,s);
      for(const msg of msgs){
        /* NE PAS ignorer les approuvés — le bot les a peut-être approuvés lors d'un poll précédent */
        if(msg.status==='pas_de_commande')continue;
        const p=parseSMS(s,msg.content);
        if(!p)continue;
        if(p.phone.replace(/[^0-9]/g,'').slice(-9)===suffix)
          return{id:msg.id,phone:p.phone,amount:p.amount};
      }
    }catch(e){}
  }
  return null;
}

/* ═══════════════════════════════════════════
   MY-MANAGMENT — identique à YapsonBot
═══════════════════════════════════════════ */
async function initBrowser(acc) {
  if(acc.browser)try{await acc.browser.close();}catch(_){}
  acc.browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox']});
  acc.page=await acc.browser.newPage();
  log(acc,'Navigateur prêt');
}

async function loginMgmt(acc) {
  const {url}=acc.mgmt;
  acc.status='connecting';
  if(acc.mgmt.cookies&&acc.mgmt.cookies.length>0){
    log(acc,`Injection de ${acc.mgmt.cookies.length} cookie(s)…`);
    try{
      await acc.page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
      await acc.page.context().addCookies(acc.mgmt.cookies);
      await acc.page.goto(`${url}/fr/admin/`,{waitUntil:'domcontentloaded',timeout:20000});
      if(!acc.page.url().includes('signin')){
        log(acc,'✅ my-managment connecté via cookies','OK');
        acc.status='running'; return true;
      }
      log(acc,'⚠️ Cookies expirés','WARN');
      acc.mgmt.cookies=[];
    }catch(e){log(acc,'⚠️ Erreur injection cookies: '+e.message,'WARN');}
    acc.status='waiting_cookies'; return false;
  }
  log(acc,'🍪 Cookies requis — injecte-les depuis le dashboard','WARN');
  acc.status='waiting_cookies'; return false;
}

async function checkSession(acc) {
  try{
    /* Naviguer vers pending deposit requests — identique à YapsonBot */
    await acc.page.goto(`${acc.mgmt.url}/fr/admin/report/pendingrequestrefill`,
      {waitUntil:'domcontentloaded',timeout:20000});
    await acc.page.waitForTimeout(1500);
    if(acc.page.url().includes('signin')||acc.page.url().includes('login')){
      log(acc,'Session expirée — cookies requis','WARN');
      acc.mgmt.cookies=[]; acc.status='waiting_cookies'; return false;
    }
    return true;
  }catch(e){log(acc,'Erreur navigation: '+e.message,'ERROR');return false;}
}

/* ═══════════════════════════════════════════
   POLL F2 — copie exacte de YapsonBot adaptée multi-comptes
═══════════════════════════════════════════ */
async function pollF2(acc) {
  const ok=await checkSession(acc); if(!ok)return;

  /* Appeler l'API JSON depuis le navigateur Playwright (même méthode que YapsonBot) */
  let items=[];
  try{
    const data=await acc.page.evaluate(async ()=>{
      const r=await fetch('/admin/report/pendingrequestrefill',{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},
        credentials:'include'
      });
      return r.json();
    });
    items=data.data||[];
  }catch(e){log(acc,'Erreur API F2: '+e.message,'ERROR');return;}

  log(acc,`F2: ${items.length} demande(s) en attente`);
  let nbConf=0,nbRej=0;

  for(const item of items){
    const id          = String(item.id);
    const summa       = parseInt(String(item.Summa||'0').replace(/[^0-9]/g,''))||0;
    const phone       = (item.dopparam||[]).find(d=>d.description&&/0[0-9]{9}/.test(d.description))?.description||'';
    const time        = parseProcTime(item.reviewTime||'');
    const confirmData = (item.confirm||[])[0]?.data||{};
    const rejectData  = (item.reject||[])[0]?.data||{};

    if(!phone){continue;}
    if(acc.confirmedIds.has(id)||acc.rejectedIds.has(id))continue;
    if(time<acc.cfg.f2ConfMin)continue;

    log(acc,`🔍 ${phone} — ${fmtAmt(summa)}F — ${time}min`);

    /* Chercher dans YapsonPress (incluant les approuvés pour eviter double confirmation) */
    const found=await findPhone(acc,phone);
    if(found){
      /* Approuver dans YapsonPress seulement si pas encore approuvé */
      if(found.status!=='approuve'){
        await apiApprove(acc,found.id);
        log(acc,`Approuvé YapsonPress: ${phone} — ${fmtAmt(found.amount)}F`,'OK');
        acc.ST.sms++;
      }

      /* Confirmer dans my-managment via page.evaluate (même méthode que YapsonBot) */
      try{
        const confirmed=await acc.page.evaluate(async (args)=>{
          const {cdata,reportId}=args;
          const fd=new FormData();
          fd.append('id',         String(cdata.id||''));
          fd.append('summa',      String(cdata.summa||''));
          fd.append('summa_user', String(cdata.summa||''));
          fd.append('comment',    '');
          fd.append('is_out',     'false');
          fd.append('report_id',  reportId);
          fd.append('subagent_id',String(cdata.subagent_id||''));
          fd.append('currency',   String(cdata.currency||''));
          const r=await fetch('/admin/banktransfer/approvemoney',{
            method:'POST',credentials:'include',body:fd
          });
          const d=await r.json().catch(()=>({}));
          return r.ok&&(d.success!==false);
        }, {cdata:confirmData, reportId:require('crypto').randomBytes(16).toString('hex')});

        if(confirmed){
          acc.confirmedIds.add(id); nbConf++; acc.ST.ok++;
          log(acc,`✅ Confirmé: ${phone} — ${fmtAmt(summa)}F`,'OK');
        }else{
          log(acc,`⚠️ Confirmation échouée: ${phone}`,'WARN');
        }
      }catch(e){log(acc,'Erreur confirmation: '+e.message,'ERROR');}

    }else if(acc.cfg.f2RejOn&&time>=acc.cfg.f2RejMin&&rejectData.id){
      log(acc,`🚫 ${phone} absent YapsonPress (${time}min ≥ ${acc.cfg.f2RejMin}min) → rejet`,'WARN');
      try{
        const rejected=await acc.page.evaluate(async (rdata)=>{
          const fd=new FormData();
          fd.append('id',    String(rdata.id||''));
          fd.append('status','2');
          const r=await fetch('/admin/banktransfer/rejectmoney',{
            method:'POST',credentials:'include',body:fd
          });
          return r.ok;
        },rejectData);
        if(rejected){acc.rejectedIds.add(id);nbRej++;acc.ST.rej++;
          log(acc,`❌ Rejeté: ${phone}`,'WARN');}
        else{log(acc,`⚠️ Rejet échoué: ${phone} (r.ok=false)`,'WARN');}
      }catch(e){log(acc,'Erreur rejet: '+e.message,'ERROR');}
    }else{
      log(acc,`⏳ ${phone} absent YapsonPress (${time}min) — pas encore rejeté`);
    }
  }
  log(acc,`Poll F2: ${nbConf} confirmé(s), ${nbRej} rejeté(s)`);
}

/* ═══════════════════════════════════════════
   POLL F1 — SMS entrants
═══════════════════════════════════════════ */
async function pollF1(acc) {
  const senders=acc.cfg.senders.split(',').map(s=>s.trim());
  const fresh=[];
  for(const s of senders){
    try{
      const msgs=await apiFetch(acc,s);
      for(const msg of msgs){
        if(new Date(msg.created_at).getTime()<=acc.lastTs)continue;
        if(acc.seen.has(msg.id)||msg.status==='pas_de_commande'||msg.status==='approuve')continue;
        const p=parseSMS(s,msg.content);
        if(p&&p.amount>0)fresh.push({id:msg.id,phone:p.phone,amount:p.amount,ts:new Date(msg.created_at).getTime()});
      }
    }catch(e){log(acc,`⚠️ ${s}: ${e.message}`,'WARN');}
  }
  if(!fresh.length){log(acc,'RAS');return;}
  log(acc,`🆕 ${fresh.length} nouveau(x) SMS`);
  acc.ST.sms+=fresh.length;
  for(const p of fresh){await apiApprove(acc,p.id);acc.seen.add(p.id);log(acc,`Approuvé YapsonPress: ${p.phone} — ${fmtAmt(p.amount)}F`);}
  const mx=Math.max(...fresh.map(p=>p.ts||0));
  if(mx>=acc.lastTs)acc.lastTs=mx+1;
  /* Confirmer sur my-managment */
  const ok=await checkSession(acc); if(!ok)return;
  for(const p of fresh){
    /* Chercher dans le tableau my-managment */
    try{
      const data=await acc.page.evaluate(async ()=>{
        const r=await fetch('/admin/report/pendingrequestrefill',{method:'POST',
          headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},
          credentials:'include'});
        return r.json();
      });
      const items=data.data||[];
      const match=items.find(it=>{
        const ph=(it.dopparam||[]).find(d=>d.description&&/0[0-9]{9}/.test(d.description))?.description||'';
        return ph.replace(/[^0-9]/g,'').slice(-9)===p.phone.replace(/[^0-9]/g,'').slice(-9);
      });
      if(match){
        const cdata=(match.confirm||[])[0]?.data||{};
        const confirmed=await acc.page.evaluate(async (args)=>{
          const {cdata,reportId}=args;
          const fd=new FormData();
          fd.append('id',String(cdata.id||'')); fd.append('summa',String(cdata.summa||''));
          fd.append('summa_user',String(cdata.summa||'')); fd.append('comment','');
          fd.append('is_out','false'); fd.append('report_id',reportId);
          fd.append('subagent_id',String(cdata.subagent_id||'')); fd.append('currency',String(cdata.currency||''));
          const r=await fetch('/admin/banktransfer/approvemoney',{method:'POST',credentials:'include',body:fd});
          const d=await r.json().catch(()=>({})); return r.ok&&(d.success!==false);
        }, {cdata, reportId:require('crypto').randomBytes(16).toString('hex')});
        if(confirmed){acc.ST.ok++;log(acc,`✅ Confirmé F1: ${p.phone} — ${fmtAmt(p.amount)}F`,'OK');}
        else{log(acc,`⚠️ Confirmation F1 échouée: ${p.phone}`,'WARN');}
      }else{
        log(acc,`⚠️ ${p.phone} introuvable sur my-managment`,'WARN');
      }
    }catch(e){log(acc,'Erreur F1 confirm: '+e.message,'ERROR');}
  }
}

/* ═══════════════════════════════════════════
   BOUCLE PAR COMPTE
═══════════════════════════════════════════ */
async function startAccount(acc) {
  log(acc,`🚀 Démarrage — F:${acc.cfg.fonction} Senders:${acc.cfg.senders}`);
  const ypOk=await loginYapson(acc);
  if(!ypOk){acc.status='error';return;}
  await initBrowser(acc);
  const mgmtOk=await loginMgmt(acc);
  if(!mgmtOk)return;
  acc.running=true; acc.lastTs=Date.now();
  async function loop(){
    if(!acc.running)return;
    acc.ST.polls++;
    try{
      if(acc.cfg.fonction==='F1')await pollF1(acc);
      else await pollF2(acc);
    }catch(e){
      log(acc,'Erreur poll: '+e.message,'ERROR');
      try{await acc.page.reload({timeout:10000});}
      catch(_){try{await initBrowser(acc);await loginMgmt(acc);}catch(__){}}
    }
    if(acc.running)acc.loopTimer=setTimeout(loop,acc.cfg.interval*1000);
  }
  loop();
}

function stopAccount(acc) {
  acc.running=false;
  if(acc.loopTimer){clearTimeout(acc.loopTimer);acc.loopTimer=null;}
  acc.status='stopped';
  log(acc,'⏹ Arrêté');
}

/* ═══════════════════════════════════════════
   DASHBOARD HTML
═══════════════════════════════════════════ */
const SL={stopped:'⏹ Arrêté',connecting:'🔄 Connexion…',waiting_cookies:'🍪 Cookies requis',running:'🟢 Actif',error:'❌ Erreur'};
const SC={stopped:'#475569',connecting:'#38bdf8',waiting_cookies:'#a78bfa',running:'#4ade80',error:'#f38ba8'};

function dashboardHTML() {
  const accs=Object.values(accounts);
  const cards=accs.map(acc=>`
<div class="card" id="acc-${acc.id}">
  <div class="card-header">
    <span class="acc-label">${acc.label}</span>
    <span class="badge" style="color:${SC[acc.status]||'#e2e8f0'}">${SL[acc.status]||acc.status}</span>
    <div class="card-btns">
      ${!acc.running?`<form action="/account/${acc.id}/start" method="POST" style="display:inline"><button class="btn btn-green">▶ Démarrer</button></form>`:''}
      ${acc.running?`<form action="/account/${acc.id}/stop" method="POST" style="display:inline"><button class="btn btn-red">⏹ Arrêter</button></form>`:''}
      <form action="/account/${acc.id}/reset" method="POST" style="display:inline"><button class="btn btn-ghost">⟳</button></form>
      <form action="/account/${acc.id}/delete" method="POST" style="display:inline"><button class="btn btn-ghost" onclick="return confirm('Supprimer ?')">🗑</button></form>
    </div>
  </div>

  ${acc.status==='waiting_cookies'?`
  <div class="box-cookies">
    <b style="color:#a78bfa">🍪 Cookies my-managment requis</b>
    <p style="font-size:.72rem;color:#94a3b8;margin:6px 0 8px">Connecte-toi sur my-managment.com → EditThisCookie → Exporter → coller ci-dessous</p>
    <form action="/account/${acc.id}/set-cookies" method="POST">
      <textarea name="cookies_json" placeholder='[{"name":"PHPSESSID","value":"..."}]'></textarea>
      <button type="submit" class="btn" style="background:#a78bfa;color:#0f1117">🍪 Injecter</button>
    </form>
  </div>`:''}

  <div class="stats-row">
    <div class="stat"><span class="n g">${acc.ST.ok}</span><span class="l">Confirmés</span></div>
    <div class="stat"><span class="n r">${acc.ST.miss}</span><span class="l">Manquants</span></div>
    <div class="stat"><span class="n b">${acc.ST.polls}</span><span class="l">Polls</span></div>
    <div class="stat"><span class="n p">${acc.ST.sms}</span><span class="l">SMS</span></div>
    <div class="stat"><span class="n w">${acc.ST.rej}</span><span class="l">Rejetés</span></div>
  </div>

  <!-- Config individuelle -->
  <form action="/account/${acc.id}/config" method="POST" class="cfg-row">
    <div class="irow"><span>Fonction:</span>
      <select name="fonction">
        <option value="F1" ${acc.cfg.fonction==='F1'?'selected':''}>📲 F1 — SMS</option>
        <option value="F2" ${acc.cfg.fonction==='F2'?'selected':''}>🕐 F2 — Tableau</option>
      </select>
    </div>
    <div class="irow"><span>Interval:</span><input type="number" name="interval" value="${acc.cfg.interval}" min="5" max="300"><span>s</span></div>
    <div class="irow"><span>F2 Conf ≥</span><input type="number" name="f2_conf" value="${acc.cfg.f2ConfMin}" min="0"><span>min</span></div>
    <label class="chk"><input type="checkbox" name="f2_rej_on" ${acc.cfg.f2RejOn?'checked':''}> Rejet auto</label>
    <div class="irow"><span>≥</span><input type="number" name="f2_rej" value="${acc.cfg.f2RejMin}" min="1"><span>min</span></div>
    <button type="submit" class="btn btn-blue">💾</button>
  </form>

  <form action="/account/${acc.id}/update" method="POST" class="form-grid">
    <div class="col">
      <p class="col-title" style="color:#38bdf8">YapsonPress</p>
      <div class="field"><label>URL</label><input name="yp_url" value="${acc.yapson.url}"></div>
      <div class="field"><label>Identifiant</label><input name="yp_user" value="${acc.yapson.username}"></div>
      <div class="field"><label>Mot de passe</label><input type="password" name="yp_pass" value="${acc.yapson.password}"></div>
    </div>
    <div class="col">
      <p class="col-title" style="color:#4ade80">my-managment</p>
      <div class="field"><label>URL</label><input name="mg_url" value="${acc.mgmt.url}"></div>
      <div class="field"><label>Identifiant</label><input name="mg_user" value="${acc.mgmt.username}"></div>
      <div class="field"><label>Mot de passe</label><input type="password" name="mg_pass" value="${acc.mgmt.password}"></div>
    </div>
    <div class="col-full">
      <div class="field" style="max-width:280px"><label>Expéditeurs (virgule)</label><input name="senders" value="${acc.cfg.senders}"></div>
      <div class="field" style="max-width:150px"><label>Label</label><input name="label" value="${acc.label}"></div>
      <button type="submit" class="btn btn-blue">💾 Sauvegarder</button>
    </div>
  </form>

  <div class="logs">
${acc.logs.slice(0,40).map(l=>`<div class="ll ${l.level}"><span class="t">${l.ts.replace('T',' ').substring(0,19)}</span><span class="m">${l.msg.replace(/</g,'&lt;')}</span></div>`).join('')}
  </div>
</div>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>BOT+</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:monospace;background:#0f1117;color:#e2e8f0;padding:20px;max-width:1100px;margin:0 auto}
h1{color:#38bdf8;font-size:1.3rem;font-weight:800;margin-bottom:16px}
.top-bar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.card{background:#161b27;border:1px solid #1e2433;border-radius:10px;padding:16px;margin-bottom:16px}
.card-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.acc-label{font-weight:700;font-size:.9rem;color:#cba6f7;flex:1}
.badge{font-size:.7rem;padding:3px 10px;border-radius:20px;background:#1e2433}
.card-btns{display:flex;gap:6px}
.btn{padding:6px 14px;border:none;border-radius:5px;font-size:.72rem;font-weight:700;cursor:pointer;font-family:monospace}
.btn-blue{background:#38bdf8;color:#0f1117}.btn-green{background:#4ade80;color:#0f1117}
.btn-red{background:#f38ba8;color:#0f1117}.btn-ghost{background:#1e2433;color:#e2e8f0}
.stats-row{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.stat{background:#0a0e18;border:1px solid #1e2433;border-radius:6px;padding:8px 12px;text-align:center;min-width:70px}
.stat .n{font-size:1.1rem;font-weight:800;display:block}
.stat .l{font-size:.58rem;color:#475569;margin-top:2px}
.g{color:#4ade80}.r{color:#f87171}.b{color:#38bdf8}.p{color:#cba6f7}.w{color:#fb923c}
.cfg-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;
  background:#0a0e18;border:1px solid #1e2433;border-radius:6px;padding:10px}
.irow{display:flex;align-items:center;gap:5px;font-size:.75rem;color:#94a3b8}
.irow input[type=number]{width:60px;background:#161b27;border:1px solid #1e2433;border-radius:4px;color:#e2e8f0;padding:4px 6px;font-family:monospace;outline:none}
.irow select{background:#161b27;border:1px solid #1e2433;border-radius:4px;color:#e2e8f0;padding:4px 6px;font-family:monospace;outline:none}
.chk{display:flex;align-items:center;gap:5px;font-size:.75rem;color:#94a3b8;cursor:pointer}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.col{background:#0a0e18;border:1px solid #1e2433;border-radius:6px;padding:10px}
.col-full{grid-column:1/-1;display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.col-title{font-size:.72rem;font-weight:700;margin-bottom:8px}
.field{margin-bottom:6px}
.field label{display:block;font-size:.6rem;color:#475569;text-transform:uppercase;margin-bottom:2px}
.field input{width:100%;background:#161b27;border:1px solid #1e2433;border-radius:4px;color:#e2e8f0;padding:6px 8px;font-family:monospace;font-size:.75rem;outline:none}
.field input:focus{border-color:#38bdf8}
.box-cookies{background:#110a1c;border:1px solid #a78bfa;border-radius:6px;padding:10px;margin-bottom:12px}
.box-cookies textarea{width:100%;height:80px;background:#0a0e18;border:1px solid #a78bfa;border-radius:4px;
  color:#cba6f7;padding:8px;font-family:monospace;font-size:.68rem;outline:none;resize:vertical;margin:6px 0}
.logs{background:#0a0e18;border:1px solid #1e2433;border-radius:6px;padding:8px;max-height:200px;overflow-y:auto}
.ll{font-size:.65rem;padding:2px 0;border-bottom:1px solid #0d1117;display:flex;gap:8px}
.ll .t{color:#313244;flex-shrink:0;width:155px;font-size:.6rem}
.OK .m{color:#4ade80}.ERROR .m{color:#f38ba8}.WARN .m{color:#fb923c}.INFO .m{color:#6c7086}
.empty{text-align:center;color:#475569;padding:40px;font-size:.85rem}
</style>
</head>
<body>
<h1>⚡ BOT+ <span style="font-size:.7rem;color:#475569;font-weight:400">${accs.length} compte(s)</span></h1>
<div class="top-bar">
  <form action="/start-all" method="POST" style="display:inline"><button class="btn btn-green">▶ Tout démarrer</button></form>
  <form action="/stop-all"  method="POST" style="display:inline"><button class="btn btn-red">⏹ Tout arrêter</button></form>
  <form action="/account/add" method="POST"><button type="submit" class="btn" style="background:#a78bfa;color:#0f1117">➕ Ajouter un compte</button></form>
</div>
${accs.length===0?'<div class="empty">Aucun compte. Clique sur <b>➕ Ajouter un compte</b> pour commencer.</div>':cards}
</body></html>`;
}

/* ═══════════════════════════════════════════
   ROUTES
═══════════════════════════════════════════ */
app.get('/', (_,res)=>res.send(dashboardHTML()));

app.post('/account/add', (_,res)=>{
  const id=nextId++; accounts[id]=mkAccount(id); res.redirect('/');
});

app.post('/account/:id/update', (req,res)=>{
  const acc=accounts[req.params.id]; if(!acc){res.redirect('/');return;}
  const b=req.body;
  if(b.label)   acc.label=b.label;
  if(b.yp_url)  acc.yapson.url=b.yp_url.trim();
  if(b.yp_user) acc.yapson.username=b.yp_user.trim();
  if(b.yp_pass) acc.yapson.password=b.yp_pass.trim();
  if(b.mg_url)  acc.mgmt.url=b.mg_url.trim();
  if(b.mg_user) acc.mgmt.username=b.mg_user.trim();
  if(b.mg_pass) acc.mgmt.password=b.mg_pass.trim();
  if(b.senders) acc.cfg.senders=b.senders.trim();
  acc.yapson.token='';
  log(acc,`Compte mis à jour`); res.redirect('/');
});

app.post('/account/:id/config', (req,res)=>{
  const acc=accounts[req.params.id]; if(!acc){res.redirect('/');return;}
  const b=req.body;
  if(b.fonction)  acc.cfg.fonction  =b.fonction;
  if(b.interval)  acc.cfg.interval  =parseInt(b.interval)||15;
  if(b.f2_conf)   acc.cfg.f2ConfMin =parseInt(b.f2_conf)||0;
  acc.cfg.f2RejOn = b.f2_rej_on==='on';
  if(b.f2_rej)    acc.cfg.f2RejMin  =parseInt(b.f2_rej)||15;
  log(acc,`Config: F:${acc.cfg.fonction} Conf≥${acc.cfg.f2ConfMin}min Rej:${acc.cfg.f2RejOn?acc.cfg.f2RejMin+'min':'off'}`);
  if(acc.running&&acc.loopTimer){clearTimeout(acc.loopTimer);acc.loopTimer=null;}
  res.redirect('/');
});

app.post('/account/:id/set-cookies', async (req,res)=>{
  const acc=accounts[req.params.id]; if(!acc){res.redirect('/');return;}
  const raw=(req.body.cookies_json||'').trim();
  try{
    const cookies=JSON.parse(raw);
    const normSS=v=>{if(!v)return'Lax';const s=String(v).toLowerCase();if(s==='strict')return'Strict';if(s==='none'||s==='no_restriction')return'None';return'Lax';};
    acc.mgmt.cookies=cookies.map(c=>({name:c.name,value:c.value,domain:c.domain||'my-managment.com',
      path:c.path||'/',secure:c.secure||false,httpOnly:c.httpOnly||false,sameSite:normSS(c.sameSite)}));
    log(acc,`🍪 ${acc.mgmt.cookies.length} cookie(s) injectés`,'OK');
    stopAccount(acc);
    startAccount(acc).catch(e=>log(acc,'Erreur démarrage: '+e.message,'ERROR'));
  }catch(e){log(acc,'Cookies invalides: '+e.message,'ERROR');}
  res.redirect('/');
});

app.post('/account/:id/start', (req,res)=>{
  const acc=accounts[req.params.id];
  if(acc&&!acc.running)startAccount(acc).catch(e=>log(acc,'Erreur: '+e.message,'ERROR'));
  res.redirect('/');
});

app.post('/account/:id/stop', (req,res)=>{
  const acc=accounts[req.params.id];
  if(acc)stopAccount(acc);
  res.redirect('/');
});

app.post('/account/:id/reset', (req,res)=>{
  const acc=accounts[req.params.id];
  if(acc){
    acc.seen.clear();acc.confirmedIds.clear();acc.rejectedIds.clear();
    acc.lastTs=Date.now();
    Object.keys(acc.ST).forEach(k=>acc.ST[k]=0);
    log(acc,'🔄 Stats réinitialisées');
  }
  res.redirect('/');
});

app.post('/account/:id/delete', (req,res)=>{
  const acc=accounts[req.params.id];
  if(acc){stopAccount(acc);if(acc.browser)acc.browser.close().catch(()=>{});delete accounts[acc.id];}
  res.redirect('/');
});

app.post('/start-all', (_,res)=>{
  for(const acc of Object.values(accounts))
    if(!acc.running)startAccount(acc).catch(e=>log(acc,'Erreur: '+e.message,'ERROR'));
  res.redirect('/');
});

app.post('/stop-all', (_,res)=>{
  for(const acc of Object.values(accounts))stopAccount(acc);
  res.redirect('/');
});

app.get('/api/status', (_,res)=>res.json(Object.values(accounts).map(acc=>({
  id:acc.id,label:acc.label,status:acc.status,ST:acc.ST,cfg:acc.cfg
}))));

/* Route debug */
app.get('/api/debug/:id', async (req,res)=>{
  const acc=accounts[req.params.id];
  if(!acc){res.json({error:'compte inconnu'});return;}
  const result={yapsonUrl:acc.yapson.url,yapsonUser:acc.yapson.username,hasToken:!!acc.yapson.token,senders:acc.cfg.senders,results:{}};
  const senders=acc.cfg.senders.split(',').map(s=>s.trim());
  for(const s of senders){
    try{
      const msgs=await apiFetch(acc,s);
      result.results[s]={count:msgs.length,samples:msgs.slice(0,5).map(m=>({id:m.id,status:m.status,content:(m.content||'').substring(0,80)}))};
    }catch(e){result.results[s]={error:e.message};}
  }
  res.json(result);
});
process.on('uncaughtException', e=>console.error('uncaughtException:',e.message));
process.on('unhandledRejection', e=>console.error('unhandledRejection:',e?.message||e));

app.listen(PORT, ()=>console.log(`BOT+ dashboard port ${PORT}`));
