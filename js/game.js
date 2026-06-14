import {getSlot, upsertSave, downloadJSON, readJSONFile, getSettings, setSettings, shouldAutosave} from './storage.js';
import {normalizeConfig, validateConfig, splitTeams, makeSchedule, newTable, sortTable, escapeHTML, loadDefaultConfig, generateRatingFromReputation} from './utils.js';

const params = new URLSearchParams(location.search);
let game = null;
let activeLeague = null;
let activePanel = 'panel-table';
const PROMOTION_SLOTS = 2;
const RELEGATION_SLOTS = 2;

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function rand(min, max){ return min + Math.random() * (max - min); }
function poisson(lambda){ const L=Math.exp(-lambda); let k=0,p=1; do{k++;p*=Math.random();}while(p>L); return k-1; }
function sanitizeTeam(t){ return {id:t.id, name:t.name, reputation:clamp(Number(t.reputation||1),1,7), rating:Number(t.rating||generateRatingFromReputation(t.reputation||1)), form:Number(t.form||0)}; }
function effectiveRating(t){ return clamp(Number(t.rating||generateRatingFromReputation(t.reputation||3)) + Number(t.form||0), 35, 99); }
function createGame(config, slot, shouldShuffle=false){
  const cfg = normalizeConfig(config);
  const divisions = splitTeams(cfg, shouldShuffle);
  Object.keys(divisions).forEach(l => divisions[l] = divisions[l].map(sanitizeTeam));
  const built = buildSeason(divisions);
  return {id:'slot_'+slot, slot:Number(slot), name:`Slot ${slot} • ${cfg.zone}`, config:cfg, zone:cfg.zone, season:2026, round:0, divisions, tables:built.tables, schedules:built.schedules, results:[], history:[], museum:{}, lastMovements:[], updatedAt:new Date().toISOString()};
}
function buildSeason(divisions){
  const tables={}, schedules={};
  for(const [league, teams] of Object.entries(divisions)){ tables[league]=newTable(teams.map(sanitizeTeam)); schedules[league]=makeSchedule(teams.map(t=>t.id)); }
  return {tables,schedules};
}
function team(league,id){ return game.divisions[league]?.find(t=>t.id===id) || {id,name:id,rating:70,reputation:3,form:0}; }
function maxRounds(){ return Math.max(0, ...Object.values(game.schedules).map(s=>s.length)); }
function currentRoundMatches(){
  const out=[];
  for(const league of Object.keys(game.schedules)){ (game.schedules[league][game.round]||[]).forEach(([homeId,awayId])=>out.push({league, home:team(league,homeId), away:team(league,awayId)})); }
  return out;
}
function simMatch(home, away){
  const h=effectiveRating(home), a=effectiveRating(away), diff=h-a;
  const tension = rand(0.90,1.12);
  const homeXg = clamp(1.18 + diff/55 + 0.18, 0.18, 2.75) * tension;
  const awayXg = clamp(1.03 - diff/60, 0.15, 2.55) * tension;
  let hg=poisson(homeXg), ag=poisson(awayXg);
  if(Math.random()<0.025 && Math.abs(diff)<8){ if(Math.random()<.5) hg++; else ag++; }
  if(Math.random()<0.03 && h>82) hg++;
  if(Math.random()<0.025 && a>82) ag++;
  return [clamp(hg,0,6), clamp(ag,0,6)];
}
function bumpForm(teamObj, result){
  const delta = result==='W' ? rand(.18,.62) : result==='L' ? -rand(.18,.62) : rand(-.12,.18);
  teamObj.form = clamp(Number(teamObj.form||0)+delta, -4.5, 4.5);
}
function applyResult(league, home, away, hg, ag){
  const h=game.tables[league][home.id], a=game.tables[league][away.id]; if(!h||!a)return;
  h.played++; a.played++; h.goalsFor+=hg; h.goalsAgainst+=ag; a.goalsFor+=ag; a.goalsAgainst+=hg;
  h.goalDifference=h.goalsFor-h.goalsAgainst; a.goalDifference=a.goalsFor-a.goalsAgainst;
  if(hg>ag){h.won++;a.lost++;h.points+=3;bumpForm(home,'W');bumpForm(away,'L');}
  else if(ag>hg){a.won++;h.lost++;a.points+=3;bumpForm(away,'W');bumpForm(home,'L');}
  else{h.drawn++;a.drawn++;h.points++;a.points++;bumpForm(home,'D');bumpForm(away,'D');}
}
function movementInfo(league,i,count){
  const leagues=game.config.leagues, idx=leagues.indexOf(league);
  if(idx>0 && i<PROMOTION_SLOTS) return {cls:'pos-promo', label:'Acesso', title:`Sobe para ${leagues[idx-1]}`};
  if(idx<leagues.length-1 && i>=count-RELEGATION_SLOTS) return {cls:'pos-releg', label:'Queda', title:`Cai para ${leagues[idx+1]}`};
  return {cls:'', label:'', title:'Permanece'};
}
function stripTeam(t){
  const rep=clamp(Number(t.reputation||1),1,7);
  return {id:t.id, name:t.name, reputation:rep, rating:clamp(Math.round(Number(t.rating||generateRatingFromReputation(rep))+rand(-2,2)),35,99), form:0};
}
function autosave(silent=true){
  upsertSave(game);
  const el=document.getElementById('autosave-status');
  if(el) el.textContent = `Autosave: ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;
  if(!silent) alert('Save atualizado no slot '+game.slot+'.');
}
function renderLeagueSelect(){
  const sel=document.getElementById('league-select');
  sel.innerHTML=game.config.leagues.map(l=>`<option value="${escapeHTML(l)}" ${l===activeLeague?'selected':''}>${escapeHTML(l)}</option>`).join('');
  sel.onchange=()=>{activeLeague=sel.value; render();};
}
function showPanel(id){ activePanel=id; document.querySelectorAll('.panel').forEach(p=>p.classList.add('hidden')); document.getElementById(id).classList.remove('hidden'); document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('active', b.dataset.panel===id)); render(); }
function renderTabs(){ document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>showPanel(b.dataset.panel)); }
function renderTable(){
  const rows=sortTable(game.tables[activeLeague]||{}), tbody=document.getElementById('tbody');
  const idx=game.config.leagues.indexOf(activeLeague), note=[];
  if(idx>0) note.push(`${PROMOTION_SLOTS} sobem`); if(idx<game.config.leagues.length-1) note.push(`${RELEGATION_SLOTS} caem`);
  document.getElementById('league-note').textContent = note.length ? note.join(' • ') : 'Divisão principal';
  tbody.innerHTML = rows.map((t,i)=>{ const mv=movementInfo(activeLeague,i,rows.length); return `<tr class="${mv.cls}"><td class="pos-col">${i+1}</td><td class="club-col"><strong>${escapeHTML(t.name)}</strong>${mv.label?`<span title="${escapeHTML(mv.title)}" class="zone-tag">${mv.label}</span>`:''}</td><td class="pts">${t.points}</td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.goalsFor}</td><td>${t.goalsAgainst}</td><td class="${t.goalDifference>0?'good':t.goalDifference<0?'bad':''}">${t.goalDifference}</td></tr>`; }).join('') || '<tr><td colspan="10">Sem times nesta divisão.</td></tr>';
}
function renderResults(){
  const box=document.getElementById('results');
  const list=game.results.filter(r=>r.league===activeLeague);
  if(!list.length){ box.innerHTML='<p class="muted">Nenhum resultado nesta divisão.</p>'; return; }
  const grouped={}; list.forEach(r=>{ (grouped[r.round] ||= []).push(r); });
  box.innerHTML = Object.keys(grouped).sort((a,b)=>Number(b)-Number(a)).map(round=>`<section class="round-results"><h3>Rodada ${round}</h3><div class="results-grid">${grouped[round].map(r=>`<div class="match-line"><span>${escapeHTML(r.home)}</span><strong>${r.homeGoals} × ${r.awayGoals}</strong><span>${escapeHTML(r.away)}</span></div>`).join('')}</div></section>`).join('');
}
function renderMuseum(){
  const box=document.getElementById('museum'); const museum=game.museum||{};
  const rows=Object.values(museum).sort((a,b)=>b.total-a.total || a.team.localeCompare(b.team));
  if(!rows.length){ box.innerHTML='<p class="muted">Nenhum título registrado ainda. Encerre uma temporada para inaugurar o museu.</p>'; return; }
  box.innerHTML = `<div class="tbl-wrap compact"><table><thead><tr><th>Clube</th><th>Total</th>${game.config.leagues.map(l=>`<th>${escapeHTML(l)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><td class="club-col"><strong>${escapeHTML(r.team)}</strong></td><td class="pts">${r.total}</td>${game.config.leagues.map(l=>`<td>${r.byLeague?.[l]||0}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function renderHistory(){
  const box=document.getElementById('history');
  const moves=(game.lastMovements||[]).length ? `<div class="notice"><strong>Movimentações mais recentes</strong>${game.lastMovements.map(m=>`<p class="muted"><i class="fa-solid ${m.type==='promotion'?'fa-arrow-up good':'fa-arrow-down bad'}"></i> ${escapeHTML(m.team)}: ${escapeHTML(m.from)} → ${escapeHTML(m.to)}</p>`).join('')}</div>` : '';
  const seasons=game.history?.length ? game.history.slice().reverse().map(h=>`<div class="save-card"><strong>${escapeHTML(game.zone)} • Temporada ${h.season}</strong>${Object.entries(h.winners).map(([l,w])=>`<p class="muted">${escapeHTML(l)}: ${escapeHTML(w)}</p>`).join('')}</div>`).join('') : '<p class="muted">Nenhuma temporada concluída.</p>';
  box.innerHTML = moves + seasons;
}
function renderSettings(){
  const settings=getSettings();
  const sel=document.getElementById('autosave-frequency');
  if(sel) sel.value=settings.autosaveFrequency||'1';
}
function render(){
  document.getElementById('zone').textContent=game.zone; document.getElementById('season').textContent='Temporada '+game.season; document.getElementById('round').textContent=`Rodada ${game.round}/${maxRounds()}`; document.getElementById('slot-pill').textContent='Slot '+game.slot;
  document.getElementById('dash-zone').textContent=game.zone; document.getElementById('museum-zone-name').textContent=game.zone; document.getElementById('dash-season').textContent=game.season; document.getElementById('dash-round').textContent=`${game.round}/${maxRounds()}`;
  document.getElementById('sim-round').innerHTML = game.round>=maxRounds() ? '<i class="fa-solid fa-flag-checkered"></i>Encerrar temporada' : '<i class="fa-solid fa-forward-step"></i>Simular rodada';
  renderLeagueSelect(); renderTable(); renderResults(); renderMuseum(); renderHistory(); renderSettings();
}
function simulateRound(){
  const matches=currentRoundMatches();
  if(!matches.length){ finishSeason(); return; }
  matches.forEach(m=>{ const [homeGoals,awayGoals]=simMatch(m.home,m.away); applyResult(m.league,m.home,m.away,homeGoals,awayGoals); game.results.push({season:game.season, round:game.round+1, league:m.league, home:m.home.name, away:m.away.name, homeGoals, awayGoals}); });
  game.round++; game.updatedAt=new Date().toISOString();
  if(shouldAutosave(game)) autosave(true);
  render();
}
function finishSeason(){
  const leagues=game.config.leagues, winners={}, sorted={}, nextDivisions={}, movements=[];
  leagues.forEach(l=>{ sorted[l]=sortTable(game.tables[l]||{}); winners[l]=sorted[l][0]?.name||'-'; });
  game.museum ||= {};
  Object.entries(winners).forEach(([league,winner])=>{ if(winner==='-')return; const key=winner.toLowerCase(); game.museum[key] ||= {team:winner,total:0,byLeague:{}}; game.museum[key].total++; game.museum[key].byLeague[league]=(game.museum[key].byLeague[league]||0)+1; });
  leagues.forEach((league,idx)=>{
    const rows=sorted[league]||[], canPromote=idx>0, canRelegate=idx<leagues.length-1;
    const stayStart=canPromote?PROMOTION_SLOTS:0, stayEnd=canRelegate?Math.max(stayStart, rows.length-RELEGATION_SLOTS):rows.length;
    nextDivisions[league]=rows.slice(stayStart,stayEnd).map(stripTeam);
    if(canPromote) rows.slice(0,PROMOTION_SLOTS).forEach(t=>movements.push({type:'promotion',team:t.name,from:league,to:leagues[idx-1]}));
    if(canRelegate) rows.slice(-RELEGATION_SLOTS).forEach(t=>movements.push({type:'relegation',team:t.name,from:league,to:leagues[idx+1]}));
  });
  leagues.forEach((league,idx)=>{ if(idx>0) nextDivisions[league].push(...(sorted[leagues[idx-1]]||[]).slice(-RELEGATION_SLOTS).map(stripTeam)); if(idx<leagues.length-1) nextDivisions[league].push(...(sorted[leagues[idx+1]]||[]).slice(0,PROMOTION_SLOTS).map(stripTeam)); });
  game.history.push({season:game.season, zone:game.zone, winners, movements});
  game.season++; game.round=0; game.divisions=nextDivisions; const built=buildSeason(game.divisions); game.tables=built.tables; game.schedules=built.schedules; game.results=[]; game.lastMovements=movements; autosave(true); alert('Temporada encerrada. Promoções, rebaixamentos e títulos aplicados.'); render();
}
function openSettings(){ document.getElementById('settings-modal').classList.add('on'); renderSettings(); }
function closeSettings(){ document.getElementById('settings-modal').classList.remove('on'); }
async function init(){
  const slot=Number(params.get('slot')||1);
  if(params.get('save')) game=getSlot(slot) || null;
  if(!game){
    let cfg=await loadDefaultConfig(); const pending=sessionStorage.getItem('avanci_pending_config'); if(pending){ cfg=JSON.parse(pending); sessionStorage.removeItem('avanci_pending_config'); }
    const errors=validateConfig(normalizeConfig(cfg)); if(errors.length) alert('Configuração inicial inválida: '+errors.join(' '));
    const shouldShuffle=confirm('Deseja embaralhar os times antes de dividir as ligas?'); game=createGame(cfg,slot,shouldShuffle); autosave(true);
  }
  game.config=normalizeConfig(game.config || await loadDefaultConfig());
  Object.keys(game.divisions||{}).forEach(l=>game.divisions[l]=game.divisions[l].map(sanitizeTeam));
  game.museum ||= {}; if(!game.tables || !game.schedules){ const built=buildSeason(game.divisions); game.tables=built.tables; game.schedules=built.schedules; }
  activeLeague=game.config.leagues[0];
  document.getElementById('sim-round').onclick=simulateRound; document.getElementById('settings-btn').onclick=openSettings; document.getElementById('close-settings').onclick=closeSettings;
  document.getElementById('export-save').onclick=()=>downloadJSON(`${game.id}.json`, game);
  document.getElementById('import-save').onchange=async e=>{ if(!e.target.files[0])return; try{ const imported=await readJSONFile(e.target.files[0]); imported.slot=game.slot; imported.id='slot_'+game.slot; game=imported; activeLeague=game.config?.leagues?.[0] || Object.keys(game.divisions||{})[0]; autosave(true); render(); closeSettings(); }catch(err){ alert('Save inválido: '+err.message); } };
  document.getElementById('autosave-frequency').onchange=e=>setSettings({autosaveFrequency:e.target.value});
  renderTabs(); render(); showPanel('panel-table');
}
window.addEventListener('DOMContentLoaded', init);
