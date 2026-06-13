import {getSaves, upsertSave, downloadJSON, readJSONFile} from './storage.js';
import {DEFAULT_CONFIG} from './defaultData.js';
import {normalizeConfig, validateConfig, splitTeams, makeSchedule, newTable, sortTable, escapeHTML} from './utils.js';
const params = new URLSearchParams(location.search);
let state=null;
let activeLeague=null;
function createGame(config, shouldShuffle=false){
  const cfg=normalizeConfig(config);
  const divisions=splitTeams(cfg, shouldShuffle);
  const tables={};
  const schedules={};
  for(const [league, teams] of Object.entries(divisions)){
    tables[league]=newTable(teams);
    schedules[league]=makeSchedule(teams.map(t=>t.id));
  }
  return {id:'save_'+Date.now(), name:`${cfg.zone} ${new Date().toLocaleDateString('pt-BR')}`, config:cfg, zone:cfg.zone, season:2026, round:0, divisions, tables, schedules, results:[], history:[], updatedAt:new Date().toISOString()};
}
function team(league,id){ return state.divisions[league]?.find(t=>t.id===id) || {id,name:id,rating:70}; }
function maxRounds(){ return Math.max(0, ...Object.values(state.schedules).map(s=>s.length)); }
function currentRoundMatches(){
  const out=[];
  for(const league of Object.keys(state.schedules)){
    const round=state.schedules[league][state.round] || [];
    round.forEach(([homeId, awayId])=>out.push({league, home:team(league,homeId), away:team(league,awayId)}));
  }
  return out;
}
function simMatch(home, away){
  const hr=(home.rating||70)+6;
  const ar=away.rating||70;
  const homeGoals=Math.max(0, Math.round(Math.random()*2.6 + (hr-ar)/30));
  const awayGoals=Math.max(0, Math.round(Math.random()*2.4 + (ar-hr)/32));
  return [homeGoals, awayGoals];
}
function applyResult(league, home, away, hg, ag){
  const table=state.tables[league];
  const h=table[home.id], a=table[away.id];
  if(!h || !a) return;
  h.played++; a.played++;
  h.goalsFor += hg; h.goalsAgainst += ag;
  a.goalsFor += ag; a.goalsAgainst += hg;
  h.goalDifference = h.goalsFor - h.goalsAgainst;
  a.goalDifference = a.goalsFor - a.goalsAgainst;
  if(hg>ag){ h.won++; a.lost++; h.points+=3; }
  else if(ag>hg){ a.won++; h.lost++; a.points+=3; }
  else { h.drawn++; a.drawn++; h.points++; a.points++; }
}
function renderNav(){
  const nav=document.getElementById('league-nav');
  nav.innerHTML=state.config.leagues.map(l=>`<div class="nav-item ${l===activeLeague?'active':''}" data-league="${escapeHTML(l)}">${escapeHTML(l)} <span class="muted">(${state.divisions[l]?.length||0})</span></div>`).join('');
  nav.querySelectorAll('[data-league]').forEach(el=>el.onclick=()=>{ activeLeague=el.dataset.league; render(); });
}
function renderTable(){
  const tbody=document.getElementById('tbody');
  const rows=sortTable(state.tables[activeLeague]||{});
  document.getElementById('view-title').textContent=activeLeague || 'Classificação';
  document.getElementById('league-note').textContent = `${rows.length} times. Critérios: pontos, vitórias, saldo de gols, gols pró e nome.`;
  tbody.innerHTML=rows.map((t,i)=>`<tr class="${i<2?'pos-promo':i>=rows.length-2?'pos-releg':''}"><td>${i+1}. ${escapeHTML(t.name)}</td><td>${t.points}</td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.goalsFor}</td><td>${t.goalsAgainst}</td><td>${t.goalDifference}</td></tr>`).join('') || '<tr><td colspan="9">Sem times nesta divisão.</td></tr>';
}
function renderResults(){
  const box=document.getElementById('results');
  const latest=state.results.slice(-80).reverse();
  box.innerHTML=latest.length ? latest.map(r=>`<div class="score-card"><div class="score-row"><span>${escapeHTML(r.league)} • Rodada ${r.round}</span><span class="score">${escapeHTML(r.home)} ${r.homeGoals} × ${r.awayGoals} ${escapeHTML(r.away)}</span></div></div>`).join('') : '<p class="muted">Nenhum resultado ainda.</p>';
}
function renderHistory(){
  const box=document.getElementById('history');
  box.innerHTML=state.history.length ? state.history.map(h=>`<div class="save-card"><strong>Temporada ${h.season}</strong>${Object.entries(h.winners).map(([l,w])=>`<p class="muted">${escapeHTML(l)}: ${escapeHTML(w)}</p>`).join('')}</div>`).join('') : '<p class="muted">Nenhuma temporada concluída.</p>';
}
function render(){
  document.getElementById('zone').textContent=state.zone;
  document.getElementById('season').textContent='Temporada '+state.season;
  document.getElementById('round').textContent=`Rodada ${state.round}/${maxRounds()}`;
  const done=state.round>=maxRounds();
  document.getElementById('sim-round').textContent = done ? 'Encerrar temporada' : 'Simular rodada';
  renderNav(); renderTable(); renderResults(); renderHistory();
}
function simulateRound(){
  const matches=currentRoundMatches();
  if(!matches.length){ finishSeason(); return; }
  matches.forEach(m=>{
    const [homeGoals, awayGoals]=simMatch(m.home, m.away);
    applyResult(m.league, m.home, m.away, homeGoals, awayGoals);
    state.results.push({round:state.round+1, league:m.league, home:m.home.name, away:m.away.name, homeGoals, awayGoals});
  });
  state.round++;
  render();
}
function finishSeason(){
  const winners={};
  for(const league of Object.keys(state.tables)) winners[league]=sortTable(state.tables[league])[0]?.name || '-';
  state.history.push({season:state.season, winners});
  const keepHistory=state.history;
  const next=createGame(state.config,false);
  state.season++;
  state.round=0;
  state.divisions=next.divisions; state.tables=next.tables; state.schedules=next.schedules; state.results=[]; state.history=keepHistory;
  alert('Temporada encerrada. Nova temporada criada.');
  render();
}
function simulateSeason(){
  while(state.round < maxRounds()) simulateRound();
  finishSeason();
}
function saveGame(){ upsertSave(state); alert('Save gravado no navegador.'); render(); }
function showPanel(id){
  document.querySelectorAll('.panel').forEach(p=>p.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('[data-panel]').forEach(n=>n.classList.toggle('active', n.dataset.panel===id));
}
async function init(){
  if(params.get('save')) state=getSaves().find(s=>s.id===params.get('save')) || null;
  if(!state){
    let cfg=DEFAULT_CONFIG;
    const pending=sessionStorage.getItem('avanci_pending_config');
    if(pending){ cfg=JSON.parse(pending); sessionStorage.removeItem('avanci_pending_config'); }
    const errors=validateConfig(normalizeConfig(cfg));
    if(errors.length) alert('Configuração inicial inválida: '+errors.join(' '));
    const shouldShuffle=confirm('Deseja embaralhar os times antes de dividir as ligas?');
    state=createGame(cfg, shouldShuffle);
  }
  state.config=normalizeConfig(state.config || DEFAULT_CONFIG);
  activeLeague=state.config.leagues[0];
  document.getElementById('sim-round').onclick=simulateRound;
  document.getElementById('sim-season').onclick=simulateSeason;
  document.getElementById('save').onclick=saveGame;
  document.getElementById('export').onclick=()=>downloadJSON(`${state.id}.json`,state);
  document.getElementById('import').onchange=async e=>{
    if(!e.target.files[0]) return;
    try{ state=await readJSONFile(e.target.files[0]); activeLeague=state.config?.leagues?.[0] || Object.keys(state.divisions||{})[0]; render(); }
    catch(err){ alert('Save inválido: '+err.message); }
  };
  document.querySelectorAll('[data-panel]').forEach(n=>n.onclick=()=>showPanel(n.dataset.panel));
  render();
}
window.addEventListener('DOMContentLoaded',init);
