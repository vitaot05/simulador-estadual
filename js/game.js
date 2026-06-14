import {getSlot, upsertSave, downloadJSON, readJSONFile, getSettings, setSettings, shouldAutosave} from './storage.js';
import {normalizeConfig, validateConfig, splitTeams, makeSchedule, newTable, sortTable, escapeHTML, loadDefaultConfig, generateRatingFromReputation} from './utils.js';

const params = new URLSearchParams(location.search);
let game = null;
let activeCompetition = null;
let activePanel = 'panel-table';
let activeViewSeason = null;
let activeResultsRound = null;
let simulationContext = null;
let simulationTimer = null;
const PROMOTION_SLOTS = 2;
const RELEGATION_SLOTS = 2;

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function rand(min, max){ return min + Math.random() * (max - min); }
function poisson(lambda){ const L=Math.exp(-lambda); let k=0,p=1; do{k++;p*=Math.random();}while(p>L); return k-1; }
function sanitizeTeam(t){ return {id:t.id, name:t.name, reputation:clamp(Number(t.reputation||1),1,7), rating:Number(t.rating||generateRatingFromReputation(t.reputation||1)), form:Number(t.form||0)}; }
function effectiveRating(t){ return clamp(Number(t.rating||generateRatingFromReputation(t.reputation||3)) + Number(t.form||0), 35, 99); }
function allTeams(){ return Object.values(game.divisions||{}).flat().map(sanitizeTeam); }
function findTeam(id){ return allTeams().find(t=>t.id===id) || {id,name:id,rating:70,reputation:3,form:0}; }
function team(league,id){ return game.divisions[league]?.find(t=>t.id===id) || findTeam(id); }
function maxRounds(){ return Math.max(0, ...Object.values(game.schedules||{}).map(s=>s.length)); }
function cupSize(total){ if(total>=64)return 64; if(total>=32)return 32; if(total>=16)return 16; if(total>=8)return 8; return 0; }
function cupRoundName(size, remaining){ if(remaining===2)return 'Final'; if(remaining===4)return 'Semifinal'; if(remaining===8)return 'Quartas'; if(remaining===16)return 'Oitavas'; return `${remaining/2}ª fase`; }
function cupRoundCount(){ return game?.cup?.size ? Math.log2(game.cup.size) : 0; }
function nextActionLabel(){
  if(simulationContext){
    const stage = currentSimulationStage();
    if(stage==='result') return 'Voltar';
    return 'Pular';
  }
  return game.round>=maxRounds() && (!game.cup?.size || game.cup?.winner) ? 'Encerrar' : 'Simular';
}
function shouldPlayCupNow(){ return game.cup?.size && !game.cup?.winner && game.phase==='cup'; }
function shouldPlaySupercupNow(){ return game.phase==='supercup' && game.pendingSupercup && !game.supercup; }
function cupRoundsTotal(){ return game?.cup?.size ? Math.log2(game.cup.size) : 0; }
function cupRoundsPlayed(){ return game?.cup?.history?.length || 0; }
function cupHasOnlyFinalLeft(){ return game?.cup?.size && !game.cup?.winner && cupRoundsPlayed() >= cupRoundsTotal()-1; }
function shouldInsertCupAfterLeague(){
  if(!game.cup?.size || game.cup.winner) return false;
  const total=cupRoundsTotal();
  if(total<=1) return false;
  return cupRoundsPlayed() < total-1 && game.round < maxRounds();
}

function createGame(config, slot, shouldShuffle=false){
  const cfg = normalizeConfig(config);
  const divisions = splitTeams(cfg, shouldShuffle);
  Object.keys(divisions).forEach(l => divisions[l] = divisions[l].map(sanitizeTeam));
  const built = buildSeason(divisions);
  const g = {id:'slot_'+slot, slot:Number(slot), name:`Slot ${slot} • ${cfg.zone}`, config:cfg, zone:cfg.zone, season:2026, round:0, divisions, tables:built.tables, schedules:built.schedules, results:[], cupResults:[], history:[], museum:{}, lastMovements:[], cup:null, supercup:null, phase:'league', pendingSupercup:null, updatedAt:new Date().toISOString()};
  game = g;
  game.cup = buildCup();
  return g;
}
function buildSeason(divisions){
  const tables={}, schedules={};
  for(const [league, teams] of Object.entries(divisions)){ tables[league]=newTable(teams.map(sanitizeTeam)); schedules[league]=makeSchedule(teams.map(t=>t.id)); }
  return {tables,schedules};
}
function buildCup(){
  const teams = allTeams();
  const size = cupSize(teams.length);
  if(!size) return {name:game.config.cup, size:0, active:false, participants:[], roundIndex:0, history:[], winner:null, runnerUp:null};
  const seeded = teams.slice().sort((a,b)=>effectiveRating(b)-effectiveRating(a) || a.name.localeCompare(b.name)).slice(0,size);
  const mixed = [];
  for(let i=0;i<size/2;i++){ mixed.push(seeded[i], seeded[size-1-i]); }
  return {name:game.config.cup, size, active:true, participants:mixed.map(t=>t.id), roundIndex:0, history:[], winner:null, runnerUp:null};
}
function currentRoundMatches(){
  const out=[];
  for(const league of Object.keys(game.schedules||{})){ (game.schedules[league][game.round]||[]).forEach(([homeId,awayId])=>out.push({league, home:team(league,homeId), away:team(league,awayId)})); }
  return out;
}
function simMatch(home, away, neutral=false){
  const h=effectiveRating(home), a=effectiveRating(away), diff=h-a;
  const homeAdv = neutral ? 0 : 0.18;
  const tension = rand(0.90,1.12);
  const homeXg = clamp(1.15 + diff/55 + homeAdv, 0.18, 2.75) * tension;
  const awayXg = clamp(1.05 - diff/60, 0.15, 2.55) * tension;
  let hg=poisson(homeXg), ag=poisson(awayXg);
  if(Math.random()<0.025 && Math.abs(diff)<8){ if(Math.random()<.5) hg++; else ag++; }
  if(Math.random()<0.03 && h>82) hg++;
  if(Math.random()<0.025 && a>82) ag++;
  return [clamp(hg,0,6), clamp(ag,0,6)];
}
function simKnockout(home, away){
  let [hg,ag]=simMatch(home,away,true), penalties=null;
  if(hg===ag){
    const hp=clamp(Math.round(rand(3,6)),0,7), ap=clamp(Math.round(rand(2,6)),0,7);
    penalties = hp===ap ? [hp+1,ap] : [hp,ap];
    return {homeGoals:hg, awayGoals:ag, penalties, winner:penalties[0]>penalties[1]?home:away};
  }
  return {homeGoals:hg, awayGoals:ag, penalties, winner:hg>ag?home:away};
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
function addTitle(teamName, competition){
  if(!teamName || teamName==='-') return;
  const key=teamName.toLowerCase();
  game.museum ||= {};
  game.museum[key] ||= {team:teamName,total:0,byCompetition:{},byLeague:{}};
  game.museum[key].total++;
  game.museum[key].byCompetition[competition]=(game.museum[key].byCompetition[competition]||0)+1;
  game.museum[key].byLeague[competition]=(game.museum[key].byLeague[competition]||0)+1;
}
function autosave(silent=true){
  upsertSave(game);
  if(!silent) alert('Save atualizado no slot '+game.slot+'.');
}
function competitionOptions(){
  const opts=[...(game.config.leagues||[])];
  if(game.config.cup) opts.push(game.config.cup);
  if(game.config.supercup) opts.push(game.config.supercup);
  return opts;
}
function isLeagueCompetition(name){ return (game.config.leagues||[]).includes(name); }
function isCupCompetition(name){ return name === game.config.cup; }
function isSupercupCompetition(name){ return name === game.config.supercup; }

function currentViewSeason(){
  const seasons=seasonOptions();
  if(!activeViewSeason || !seasons.includes(Number(activeViewSeason))) activeViewSeason = game.season;
  return Number(activeViewSeason);
}
function renderSeasonSelect(){
  const sel=document.getElementById('season-select');
  if(!sel) return;
  const seasons=seasonOptions();
  if(!activeViewSeason || !seasons.includes(Number(activeViewSeason))) activeViewSeason = game.season;
  sel.innerHTML = seasons.map(y=>`<option value="${y}" ${Number(y)===Number(activeViewSeason)?'selected':''}>${y}</option>`).join('');
  sel.onchange = ()=>{ activeViewSeason=Number(sel.value); activeResultsRound=null; render(); };
}

function renderCompetitionSelect(){
  const sel=document.getElementById('competition-select');
  if(!sel) return;
  const opts=competitionOptions();
  activeCompetition = opts.includes(activeCompetition) ? activeCompetition : opts[0];
  sel.innerHTML=opts.map(l=>`<option value="${escapeHTML(l)}" ${l===activeCompetition?'selected':''}>${escapeHTML(l)}</option>`).join('');
  sel.onchange=()=>{activeCompetition=sel.value; activeResultsRound=null; render();};
}
function showPanel(id){ activePanel=id; document.querySelectorAll('.panel').forEach(p=>p.classList.add('hidden')); document.getElementById(id).classList.remove('hidden'); document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('active', b.dataset.panel===id)); render(); }
function renderTabs(){ document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>showPanel(b.dataset.panel)); }
function standingsTable(league){
  const rows=sortTable(game.tables[league]||{});
  if(!rows.length) return '<p class="empty-text">Sem clubes.</p>';
  return `<div class="tbl-wrap"><table class="standings-table"><thead><tr><th class="pos-col">#</th><th class="club-col">Clube</th><th>Pts</th><th>J</th><th>V</th><th>E</th><th>D</th><th>GP</th><th>GC</th><th>SG</th></tr></thead><tbody>${rows.map((t,i)=>{ const mv=movementInfo(league,i,rows.length); return `<tr class="${mv.cls}"><td class="pos-col">${i+1}</td><td class="club-col">${escapeHTML(t.name)}</td><td class="pts">${t.points}</td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.goalsFor}</td><td>${t.goalsAgainst}</td><td class="${t.goalDifference>0?'good':t.goalDifference<0?'bad':''}">${t.goalDifference}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function renderCompetition(){
  const box=document.getElementById('competition-view');
  if(!box) return;
  const comp=activeCompetition;
  const season=currentViewSeason();
  if(isLeagueCompetition(comp)){
    const finals=finalTablesForSeason(season);
    if(Number(season)!==Number(game.season)){
      box.innerHTML = finals?.[comp] ? renderMiniTable(comp, finals[comp]||[]) : '<p class="empty-text">Sem tabela final para esta temporada.</p>';
    } else {
      box.innerHTML=standingsTable(comp);
    }
    return;
  }
  if(isCupCompetition(comp)){
    const cupList=cupResultsForSeason(season);
    if(cupList.length){
      const grouped={}; cupList.forEach(r=>{ (grouped[r.name || comp] ||= []).push(r); });
      const keys=Object.keys(grouped);
      box.innerHTML = keys.map(name=>`<section class="round-results"><h3>${escapeHTML(name)}</h3><div class="results-list">${grouped[name].map(matchLine).join('')}</div></section>`).join('');
    } else {
      const cup=Number(season)===Number(game.season) ? (game.cup || buildCup()) : null;
      const status = cup && cup.size ? (cup.winner ? `Campeão: ${cup.winner}` : `Próxima fase: ${cupRoundName(cup.size, cup.participants.length)}`) : 'Sem jogos disputados.';
      box.innerHTML = `<p class="empty-text">${escapeHTML(status)}</p>`;
    }
    return;
  }
  const sc=supercupForSeason(season);
  box.innerHTML = sc ? `<div class="results-list">${matchLine(sc)}</div><p class="cup-winner">Campeão: ${escapeHTML(sc.winner)}</p>` : `<p class="empty-text">Sem supercopa disputada.</p>`;
}
function seasonOptions(){
  const seasons = [game.season, ...(game.history||[]).map(h=>h.season)].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>b-a);
  return seasons;
}
function resultsForSeason(season){
  if(Number(season)===Number(game.season)) return game.results||[];
  const h=(game.history||[]).find(x=>Number(x.season)===Number(season));
  return h?.leagueResults || [];
}
function matchLine(r){
  return `<div class="match-line"><span>${escapeHTML(r.home)}</span><strong>${r.homeGoals} × ${r.awayGoals}${r.penalties ? ` <small>(${r.penalties[0]}-${r.penalties[1]} pen.)</small>` : ''}</strong><span>${escapeHTML(r.away)}</span></div>`;
}
function finalTablesForSeason(season){
  if(Number(season)===Number(game.season)) return null;
  const h=(game.history||[]).find(x=>Number(x.season)===Number(season));
  return h?.finalTables || null;
}
function cupResultsForSeason(season){
  if(Number(season)===Number(game.season)) return game.cupResults||[];
  const h=(game.history||[]).find(x=>Number(x.season)===Number(season));
  return h?.cupResults || [];
}
function supercupForSeason(season){
  if(Number(season)===Number(game.season)) return game.supercup || null;
  const h=(game.history||[]).find(x=>Number(x.season)===Number(season));
  return h?.supercup || null;
}
function renderMiniTable(league, rows){
  if(!rows?.length) return '';
  return `<section class="result-section"><h3>${escapeHTML(league)}</h3><div class="tbl-wrap compact"><table><thead><tr><th class="pos-col">#</th><th class="club-col">Clube</th><th>Pts</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th></tr></thead><tbody>${rows.map((t,i)=>`<tr><td class="pos-col">${i+1}</td><td class="club-col">${escapeHTML(t.name)}</td><td class="pts">${t.points}</td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.goalDifference}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function resultOptionsForCompetition(season, comp){
  if(isLeagueCompetition(comp)){
    const opts=[];
    const rounds=[...new Set(resultsForSeason(season).filter(r=>r.league===comp).map(r=>Number(r.round)))].sort((a,b)=>b-a);
    rounds.forEach(r=>opts.push({value:String(r), label:`Rodada ${r}`}));
    return opts;
  }
  if(isCupCompetition(comp)){
    const names=[...new Set(cupResultsForSeason(season).map(r=>r.name || comp))].reverse();
    return names.map(n=>({value:n,label:n}));
  }
  if(isSupercupCompetition(comp)) return supercupForSeason(season) ? [{value:'supercup', label:comp}] : [];
  return [];
}
function renderResults(){
  const box=document.getElementById('results'); if(!box) return;
  const season=currentViewSeason();
  const comp=activeCompetition;
  let html='';
  if(isLeagueCompetition(comp)){
    const byRound={};
    resultsForSeason(season).filter(r=>r.league===comp).forEach(r=>{
      const key=Number(r.round)||0;
      (byRound[key] ||= []).push(r);
    });
    const rounds=Object.keys(byRound).map(Number).sort((a,b)=>a-b);
    html = rounds.length ? rounds.map(r=>`<section class="round-results"><h3>Rodada ${r}</h3><div class="results-list">${byRound[r].map(matchLine).join('')}</div></section>`).join('') : '<p class="empty-text">Sem resultados.</p>';
  } else if(isCupCompetition(comp)){
    const byPhase={};
    cupResultsForSeason(season).forEach(r=>{ const key=r.name||comp; (byPhase[key] ||= []).push(r); });
    const phases=Object.keys(byPhase);
    html = phases.length ? phases.map(name=>`<section class="round-results"><h3>${escapeHTML(name)}</h3><div class="results-list">${byPhase[name].map(matchLine).join('')}</div></section>`).join('') : '<p class="empty-text">Sem resultados.</p>';
  } else if(isSupercupCompetition(comp)){
    const sc=supercupForSeason(season);
    html = sc ? `<section class="round-results"><h3>${escapeHTML(comp)}</h3><div class="results-list">${matchLine(sc)}</div><p class="cup-winner">Campeão: ${escapeHTML(sc.winner)}</p></section>` : '<p class="empty-text">Sem resultados.</p>';
  }
  box.innerHTML=html;
}
function calendarEvents(){
  const events=[];
  const hasSupercup = !!(game.pendingSupercup || game.supercup);
  if(hasSupercup){
    const base = game.pendingSupercup || game.supercup || {};
    const sub = game.supercup ? `${game.supercup.home} × ${game.supercup.away}` : `${base.mainChampion || '-'} × ${base.cupWinner || '-'}`;
    events.push({kind:'supercup', title:game.config.supercup || 'Supercopa', sub, status:game.supercup?'done':'todo'});
  }
  const max=maxRounds();
  const total=cupRoundsTotal();
  let cupIdx=0;
  for(let i=1;i<=max;i++){
    events.push({kind:'league', title:`Rodada ${i}`, sub:'Liga', status:i<=game.round?'done':'todo'});
    if(game.cup?.size && cupIdx<Math.max(0,total-1)){
      const played=game.cup.history?.[cupIdx];
      const remaining=game.cup.size / Math.pow(2, cupIdx);
      const title=played?.name || cupRoundName(game.cup.size, remaining);
      events.push({kind:'cup', title, sub:game.config.cup || 'Copa', status:played?'done':'todo'});
      cupIdx++;
    }
  }
  if(game.cup?.size){
    const finalIdx=total-1;
    const played=game.cup.history?.[finalIdx];
    events.push({kind:'cup', title:played?.name || 'Final', sub:game.config.cup || 'Copa', status:played?'done':'todo'});
  }
  return events;
}
function renderCalendar(){
  const box=document.getElementById('calendar'); if(!box) return;
  const events=calendarEvents();
  box.innerHTML = `<div class="calendar-grid">${events.map((it,idx)=>`<div class="calendar-day ${it.kind} ${it.status}"><span>${idx+1}</span><strong>${escapeHTML(it.title)}</strong><small>${escapeHTML(it.sub)}</small></div>`).join('')}</div>`;
}
function formatCupScore(r){ const pen = r.penalties ? ` (${r.penalties[0]}-${r.penalties[1]} pen.)` : ''; return `${r.homeGoals} × ${r.awayGoals}${pen}`; }
function renderCups(){
  const box=document.getElementById('cups');
  const cup=game.cup || buildCup();
  const supercup=game.supercup;
  const cupStatus = !cup.size ? 'Copa indisponível: mínimo de 8 clubes.' : cup.winner ? `Campeão: ${cup.winner}` : `${cup.size} clubes · próxima fase: ${cupRoundName(cup.size, cup.participants.length)}`;
  const cupHistory = (cup.history||[]).slice().reverse().map(round=>`<section class="round-results"><h3>${escapeHTML(round.name)}</h3><div class="results-grid">${round.matches.map(r=>`<div class="match-line"><span>${escapeHTML(r.home)}</span><strong>${formatCupScore(r)}</strong><span>${escapeHTML(r.away)}</span></div>`).join('')}</div></section>`).join('') || '<p class="muted">Nenhum jogo de copa disputado ainda.</p>';
  const superHtml = supercup ? `<div class="cup-card"><h3>${escapeHTML(game.config.supercup)}</h3><p class="muted">${escapeHTML(supercup.home)} ${supercup.homeGoals} × ${supercup.awayGoals} ${escapeHTML(supercup.away)}</p><div class="cup-winner">${escapeHTML(supercup.winner)}</div></div>` : `<div class="cup-card"><h3>${escapeHTML(game.config.supercup)}</h3><p class="muted">Será disputada entre campeão da liga principal e campeão da copa.</p></div>`;
  box.innerHTML = `<div class="cup-card"><h3>${escapeHTML(cup.name)}</h3><p class="muted">${escapeHTML(cupStatus)}</p>${cup.winner?`<div class="cup-winner">${escapeHTML(cup.winner)}</div>`:''}</div>${cupHistory}${superHtml}`;
}
function renderMuseum(){
  const box=document.getElementById('museum'); const museum=game.museum||{};
  const competitions=[...game.config.leagues, game.config.cup, game.config.supercup];
  const rows=Object.values(museum).sort((a,b)=>b.total-a.total || a.team.localeCompare(b.team));
  if(!rows.length){ box.innerHTML='<p class="muted">Nenhum título registrado ainda.</p>'; return; }
  box.innerHTML = `<div class="tbl-wrap compact"><table><thead><tr><th>Clube</th><th>Total</th>${competitions.map(l=>`<th>${escapeHTML(l)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><td class="club-col"><strong>${escapeHTML(r.team)}</strong></td><td class="pts">${r.total}</td>${competitions.map(l=>`<td>${r.byCompetition?.[l]||r.byLeague?.[l]||0}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function renderHistory(){
  const box=document.getElementById('history');
  const moves=(game.lastMovements||[]).length ? `<div class="notice"><strong>Movimentações</strong>${game.lastMovements.map(m=>`<p class="muted">${m.type==='promotion'?'↑':'↓'} ${escapeHTML(m.team)}: ${escapeHTML(m.from)} → ${escapeHTML(m.to)}</p>`).join('')}</div>` : '';
  const seasons=game.history?.length ? game.history.slice().reverse().map(h=>`<div class="save-card"><strong>${escapeHTML(game.zone)} · ${h.season}</strong>${Object.entries(h.winners).map(([l,w])=>`<p class="muted">${escapeHTML(l)}: ${escapeHTML(w)}</p>`).join('')}${h.cupWinner?`<p class="muted">${escapeHTML(game.config.cup)}: ${escapeHTML(h.cupWinner)}</p>`:''}${h.supercupWinner?`<p class="muted">${escapeHTML(game.config.supercup)}: ${escapeHTML(h.supercupWinner)}</p>`:''}</div>`).join('') : '<p class="muted">Nenhuma temporada concluída.</p>';
  box.innerHTML = moves + seasons;
}
function renderSettings(){
  const settings=getSettings();
  const auto=document.getElementById('autosave-frequency');
  const speed=document.getElementById('simulation-speed');
  if(auto && document.activeElement!==auto) auto.value=settings.autosaveFrequency||'1';
  if(speed && document.activeElement!==speed) speed.value=String(settings.simulationSpeed||600);
}
function currentWeekLabel(){
  const done = (game.supercup ? 1 : 0) + Number(game.round||0) + cupRoundsPlayed();
  let type = 'Liga';
  if(shouldPlaySupercupNow()) type = game.config.supercup || 'Supercopa';
  else if(shouldPlayCupNow()) type = game.config.cup || 'Copa';
  else if(game.round>=maxRounds() && game.cup?.size && !game.cup.winner) type = game.config.cup || 'Copa';
  else if(game.round>=maxRounds() && (!game.cup?.size || game.cup.winner)) type = 'Encerrar temporada';
  return `Semana ${done+1}: ${type}`;
}
function renderBottomNav(){
  document.querySelectorAll('.bottom-icon').forEach(b=>{
    b.classList.toggle('active', b.dataset.panel===activePanel);
    b.onclick=()=>{ clearSimulationTimer(); simulationContext=null; syncSimulationMode(); showPanel(b.dataset.panel); };
  });
  const label=document.getElementById('week-label'); if(label) label.textContent=simulationContext ? simulationStatusLabel() : currentWeekLabel();
  const sim=document.getElementById('sim-round'); if(sim) sim.textContent = nextActionLabel();
}
function render(){
  syncSimulationMode();
  renderSeasonSelect(); renderCompetitionSelect(); renderCompetition(); renderResults(); renderCalendar(); renderMuseum(); renderSimulation(); renderSettings(); renderBottomNav();
}
function simulateCupRound(){
  const cup=game.cup; if(!cup || !cup.size || cup.winner || cup.participants.length<2) return;
  const remaining=cup.participants.length, roundName=cupRoundName(cup.size, remaining), next=[], matches=[];
  for(let i=0;i<cup.participants.length;i+=2){
    const home=findTeam(cup.participants[i]), away=findTeam(cup.participants[i+1]);
    const r=simKnockout(home,away); next.push(r.winner.id);
    matches.push({season:game.season, name:roundName, home:home.name, away:away.name, homeGoals:r.homeGoals, awayGoals:r.awayGoals, penalties:r.penalties, winner:r.winner.name});
  }
  cup.history.push({name:roundName, matches});
  game.cupResults.push(...matches);
  cup.roundIndex++;
  cup.participants=next;
  if(next.length===1){ cup.winner=findTeam(next[0]).name; const finalMatch=matches[0]; cup.runnerUp = finalMatch ? (finalMatch.winner===finalMatch.home ? finalMatch.away : finalMatch.home) : null; addTitle(cup.winner, game.config.cup); }
}
function playPendingSupercup(){
  const pending=game.pendingSupercup;
  if(!pending) return null;
  const res=simulateSupercup(pending.mainChampion, pending.cupWinner);
  if(res){ game.supercup=res; game.supercup.season=game.season; }
  game.pendingSupercup=null;
  return res;
}
function simulationDelay(){ return Number(getSettings().simulationSpeed || 600); }
function clearSimulationTimer(){ if(simulationTimer){ clearTimeout(simulationTimer); simulationTimer=null; } }
function currentSimulationStage(){ return simulationContext?.stages?.[simulationContext.stageIndex] || null; }
function simulationStatusLabel(){
  const stage=currentSimulationStage();
  const type=simulationContext?.label || 'Simulação';
  const names={warmup:'Aquecimento',first:'1º tempo',halftime:'Intervalo',second:'2º tempo',penalties:'Pênaltis',result:'Resultado'};
  return `${type}: ${names[stage] || ''}`;
}
function simulationClockLabel(stage){
  const labels={warmup:'00:00',first:'45:00',halftime:'INT',second:'90:00',penalties:'PEN',result:'FIM'};
  return labels[stage] || '00:00';
}
function syncSimulationMode(){
  document.body.classList.toggle('simulation-active', !!simulationContext);
}
function simulationStages(ctx){
  if(ctx.type==='seasonEnd') return ['result'];
  const hasPenalties = ctx.matches?.some(m=>m.penalties);
  return ['warmup','first','halftime','second', ...(hasPenalties?['penalties']:[]), 'result'];
}
function buildLeagueSimulationContext(){
  const matches=currentRoundMatches();
  if(!matches.length) return null;
  const round=game.round+1;
  const simMatches=matches.map(m=>{ const [homeGoals,awayGoals]=simMatch(m.home,m.away); return {league:m.league, homeId:m.home.id, awayId:m.away.id, home:m.home.name, away:m.away.name, homeGoals, awayGoals}; });
  return {type:'league', label:`Rodada ${round}`, round, matches:simMatches};
}
function buildCupSimulationContext(){
  const cup=game.cup; if(!cup || !cup.size || cup.winner || cup.participants.length<2) return null;
  const remaining=cup.participants.length;
  const roundName=cupRoundName(cup.size, remaining);
  const matches=[];
  for(let i=0;i<cup.participants.length;i+=2){
    const home=findTeam(cup.participants[i]), away=findTeam(cup.participants[i+1]);
    const r=simKnockout(home,away);
    matches.push({homeId:home.id, awayId:away.id, home:home.name, away:away.name, homeGoals:r.homeGoals, awayGoals:r.awayGoals, penalties:r.penalties, winnerId:r.winner.id, winner:r.winner.name});
  }
  return {type:'cup', label:roundName, roundName, matches};
}
function buildSupercupSimulationContext(){
  const pending=game.pendingSupercup; if(!pending) return null;
  let mainChampion=pending.mainChampion, cupWinner=pending.cupWinner;
  if(!mainChampion || !cupWinner || mainChampion==='-' || cupWinner==='-') return null;
  let opponent=cupWinner;
  if(opponent===mainChampion && game.cup?.runnerUp) opponent=game.cup.runnerUp;
  if(opponent===mainChampion) return null;
  const home=allTeams().find(t=>t.name===mainChampion) || {id:mainChampion,name:mainChampion,rating:78,reputation:4};
  const away=allTeams().find(t=>t.name===opponent) || {id:opponent,name:opponent,rating:78,reputation:4};
  const r=simKnockout(home, away);
  return {type:'supercup', label:game.config.supercup || 'Supercopa', matches:[{homeId:home.id, awayId:away.id, home:home.name, away:away.name, homeGoals:r.homeGoals, awayGoals:r.awayGoals, penalties:r.penalties, winnerId:r.winner.id, winner:r.winner.name}]};
}
function buildSimulationContext(){
  let ctx=null;
  if(shouldPlaySupercupNow()) ctx=buildSupercupSimulationContext();
  else if(shouldPlayCupNow()) ctx=buildCupSimulationContext();
  else ctx=buildLeagueSimulationContext();
  if(!ctx){
    if(game.cup?.size && !game.cup.winner){ game.phase='cup'; ctx=buildCupSimulationContext(); }
    else ctx={type:'seasonEnd', label:'Fim da temporada', matches:[]};
  }
  ctx.stageIndex=0;
  ctx.stages=simulationStages(ctx);
  return ctx;
}
function renderSimulationMatches(ctx, stage){
  if(ctx.type==='seasonEnd') return '<p class="empty-text">A temporada será encerrada e os acessos/rebaixamentos serão aplicados.</p>';
  const line = m => {
    const score = (stage==='warmup') ? '×' : `${m.homeGoals} × ${m.awayGoals}`;
    const pen = (stage==='penalties' || stage==='result') && m.penalties ? `<small>${m.penalties[0]}-${m.penalties[1]} pen.</small>` : '';
    return `<div class="simulation-match"><span>${escapeHTML(m.home)}</span><strong>${score}${pen}</strong><span>${escapeHTML(m.away)}</span></div>`;
  };
  if(ctx.type==='league'){
    const grouped={};
    ctx.matches.forEach(m=>{ (grouped[m.league] ||= []).push(m); });
    return `<div class="simulation-groups">${Object.entries(grouped).map(([league,matches])=>`<section class="simulation-group"><h3>${escapeHTML(league)}</h3><div class="simulation-list">${matches.map(line).join('')}</div></section>`).join('')}</div>`;
  }
  return `<div class="simulation-list">${ctx.matches.map(line).join('')}</div>`;
}
function renderSimulation(){
  const box=document.getElementById('simulation-view'); if(!box) return;
  if(!simulationContext){ box.innerHTML=''; return; }
  const stage=currentSimulationStage();
  const note={warmup:'Pré-rodada',first:'1º tempo',halftime:'Intervalo',second:'2º tempo',penalties:'Pênaltis',result:'Resultado'}[stage] || '';
  const actionLabel = nextActionLabel();
  box.innerHTML=`<section class="simulation-card">
    <div class="simulation-head">
      <div><span>${escapeHTML(simulationContext.label)}</span><strong>${escapeHTML(note)}</strong></div>
      <div class="simulation-clock" aria-label="Cronômetro">${simulationClockLabel(stage)}</div>
    </div>
    ${renderSimulationMatches(simulationContext, stage)}
    <div class="simulation-actions"><button class="btn primary" id="simulation-step">${escapeHTML(actionLabel)}</button></div>
  </section>`;
  const step=document.getElementById('simulation-step');
  if(step) step.onclick=()=>stepSimulation(false);
}
function commitLeagueSimulation(ctx){
  ctx.matches.forEach(m=>{ const h=team(m.league,m.homeId), a=team(m.league,m.awayId); applyResult(m.league,h,a,m.homeGoals,m.awayGoals); game.results.push({season:game.season, round:ctx.round, league:m.league, home:m.home, away:m.away, homeGoals:m.homeGoals, awayGoals:m.awayGoals}); });
  game.round++;
  game.phase = shouldInsertCupAfterLeague() ? 'cup' : 'league';
}
function commitCupSimulation(ctx){
  const cup=game.cup; const next=[];
  const matches=ctx.matches.map(m=>{ next.push(m.winnerId); return {season:game.season, name:ctx.roundName, home:m.home, away:m.away, homeGoals:m.homeGoals, awayGoals:m.awayGoals, penalties:m.penalties, winner:m.winner}; });
  cup.history.push({name:ctx.roundName, matches});
  game.cupResults.push(...matches);
  cup.roundIndex++;
  cup.participants=next;
  if(next.length===1){ cup.winner=findTeam(next[0]).name; const finalMatch=matches[0]; cup.runnerUp = finalMatch ? (finalMatch.winner===finalMatch.home ? finalMatch.away : finalMatch.home) : null; addTitle(cup.winner, game.config.cup); }
  game.phase='league';
}
function commitSupercupSimulation(ctx){
  const m=ctx.matches[0];
  const res={season:game.season, home:m.home, away:m.away, homeGoals:m.homeGoals, awayGoals:m.awayGoals, penalties:m.penalties, winner:m.winner};
  addTitle(res.winner, game.config.supercup);
  game.supercup=res;
  game.pendingSupercup=null;
  game.phase='league';
}
function commitSimulation(ctx){
  if(ctx.type==='league') commitLeagueSimulation(ctx);
  else if(ctx.type==='cup') commitCupSimulation(ctx);
  else if(ctx.type==='supercup') commitSupercupSimulation(ctx);
  else if(ctx.type==='seasonEnd'){ finishSeason(); return; }
  game.updatedAt=new Date().toISOString();
  if(ctx.type==='cup' && game.cup?.winner && game.round>=maxRounds()) { if(shouldAutosave(game)) autosave(true); finishSeason(); return; }
  if(shouldAutosave(game)) autosave(true);
}
function autoAdvanceSimulation(){
  clearSimulationTimer();
  if(!simulationContext) return;
  const stage=currentSimulationStage();
  if(stage==='result') return;
  simulationTimer=setTimeout(()=>stepSimulation(true), simulationDelay());
}
function beginSimulation(){
  simulationContext=buildSimulationContext();
  showPanel('panel-simulation');
  render();
  autoAdvanceSimulation();
}
function stepSimulation(auto=false){
  if(!simulationContext){ beginSimulation(); return; }
  clearSimulationTimer();
  const stage=currentSimulationStage();
  if(stage==='result'){
    const ctx=simulationContext;
    simulationContext=null;
    commitSimulation(ctx);
    showPanel('panel-table');
    render();
    return;
  }
  simulationContext.stageIndex++;
  render();
  autoAdvanceSimulation();
}
function simulateRound(){ stepSimulation(false); }
function simulateSupercup(mainChampion, cupWinner){
  if(!mainChampion || !cupWinner || mainChampion==='-' || cupWinner==='-') return null;
  let opponent = cupWinner;
  if(opponent === mainChampion && game.cup?.runnerUp) opponent = game.cup.runnerUp;
  if(opponent === mainChampion) return null;
  const home=allTeams().find(t=>t.name===mainChampion) || {id:mainChampion,name:mainChampion,rating:78,reputation:4};
  const away=allTeams().find(t=>t.name===opponent) || {id:opponent,name:opponent,rating:78,reputation:4};
  const r=simKnockout(home, away);
  addTitle(r.winner.name, game.config.supercup);
  return {season:game.season, home:home.name, away:away.name, homeGoals:r.homeGoals, awayGoals:r.awayGoals, penalties:r.penalties, winner:r.winner.name};
}
function finishSeason(){
  while(game.cup && game.cup.size && !game.cup.winner) simulateCupRound();
  const leagues=game.config.leagues, winners={}, sorted={}, nextDivisions={}, movements=[];
  leagues.forEach(l=>{ sorted[l]=sortTable(game.tables[l]||{}); winners[l]=sorted[l][0]?.name||'-'; addTitle(winners[l], l); });
  const supercupResult=null;
  leagues.forEach((league,idx)=>{
    const rows=sorted[league]||[], canPromote=idx>0, canRelegate=idx<leagues.length-1;
    const stayStart=canPromote?PROMOTION_SLOTS:0, stayEnd=canRelegate?Math.max(stayStart, rows.length-RELEGATION_SLOTS):rows.length;
    nextDivisions[league]=rows.slice(stayStart,stayEnd).map(stripTeam);
    if(canPromote) rows.slice(0,PROMOTION_SLOTS).forEach(t=>movements.push({type:'promotion',team:t.name,from:league,to:leagues[idx-1]}));
    if(canRelegate) rows.slice(-RELEGATION_SLOTS).forEach(t=>movements.push({type:'relegation',team:t.name,from:league,to:leagues[idx+1]}));
  });
  leagues.forEach((league,idx)=>{ if(idx>0) nextDivisions[league].push(...(sorted[leagues[idx-1]]||[]).slice(-RELEGATION_SLOTS).map(stripTeam)); if(idx<leagues.length-1) nextDivisions[league].push(...(sorted[leagues[idx+1]]||[]).slice(0,PROMOTION_SLOTS).map(stripTeam)); });
  game.history.push({season:game.season, zone:game.zone, winners, cupWinner:game.cup?.winner||null, supercupWinner:null, supercup:null, movements, finalTables:Object.fromEntries(leagues.map(l=>[l, sorted[l]||[]])), leagueResults:[...(game.results||[])], cupResults:[...(game.cupResults||[])]});
  game.season++; game.round=0; game.pendingSupercup={season:game.season, mainChampion:winners[leagues[0]], cupWinner:game.cup?.winner||null}; game.supercup=null; game.phase=game.pendingSupercup?.cupWinner ? 'supercup' : 'league'; game.divisions=nextDivisions; const built=buildSeason(game.divisions); game.tables=built.tables; game.schedules=built.schedules; game.results=[]; game.cupResults=[]; game.lastMovements=movements; game.cup=buildCup(); autosave(true); alert('Temporada encerrada.'); render();
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
  game.cup ||= buildCup(); game.cupResults ||= []; game.results ||= []; game.history ||= []; game.pendingSupercup ||= null; if(game.pendingSupercup && !game.supercup) game.phase='supercup'; game.phase ||= 'league';
  activeCompetition=competitionOptions().includes(activeCompetition) ? activeCompetition : competitionOptions()[0]; activeViewSeason=game.season;
  document.getElementById('sim-round').onclick=simulateRound; document.getElementById('settings-btn').onclick=openSettings; document.getElementById('close-settings').onclick=closeSettings;
  document.getElementById('export-save').onclick=()=>downloadJSON(`${game.id}.json`, game);
  document.getElementById('import-save').onchange=async e=>{ if(!e.target.files[0])return; try{ const imported=await readJSONFile(e.target.files[0]); imported.slot=game.slot; imported.id='slot_'+game.slot; game=imported; game.config=normalizeConfig(game.config); activeCompetition=game.config?.leagues?.[0] || Object.keys(game.divisions||{})[0]; autosave(true); render(); closeSettings(); }catch(err){ alert('Save inválido: '+err.message); } };
  document.getElementById('autosave-frequency').onchange=e=>setSettings({autosaveFrequency:e.target.value});
  document.getElementById('simulation-speed').onchange=e=>setSettings({simulationSpeed:Number(e.target.value)});
  renderTabs(); render(); showPanel('panel-table');
}
window.addEventListener('DOMContentLoaded', init);
