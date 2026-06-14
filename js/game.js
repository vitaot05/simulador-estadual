import {getSaves, upsertSave, downloadJSON, readJSONFile} from './storage.js';
import {normalizeConfig, validateConfig, splitTeams, makeSchedule, newTable, sortTable, escapeHTML, loadDefaultConfig, generateRatingFromReputation} from './utils.js';

const params = new URLSearchParams(location.search);
let state = null;
let activeLeague = null;

const PROMOTION_SLOTS = 2;
const RELEGATION_SLOTS = 2;

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function rand(min, max){ return min + Math.random() * (max - min); }
function poisson(lambda){
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}
function effectiveRating(t){
  const base = Number(t.rating || generateRatingFromReputation(t.reputation || 3));
  const form = Number(t.form || 0);
  return clamp(base + form, 35, 99);
}
function prepareTeam(t){
  const reputation = clamp(Number(t.reputation || 1), 1, 7);
  return {
    ...t,
    reputation,
    rating: Number(t.rating || generateRatingFromReputation(reputation)),
    form: Number(t.form || 0)
  };
}
function createGame(config, shouldShuffle=false){
  const cfg = normalizeConfig(config);
  const divisions = splitTeams(cfg, shouldShuffle);
  for (const league of Object.keys(divisions)) divisions[league] = divisions[league].map(prepareTeam);
  const {tables, schedules} = buildSeason(divisions);
  return {
    id: 'save_' + Date.now(),
    name: `${cfg.zone} ${new Date().toLocaleDateString('pt-BR')}`,
    config: cfg,
    zone: cfg.zone,
    season: 2026,
    round: 0,
    divisions,
    tables,
    schedules,
    results: [],
    history: [],
    lastMovements: [],
    updatedAt: new Date().toISOString()
  };
}
function buildSeason(divisions){
  const tables = {}, schedules = {};
  for (const [league, teams] of Object.entries(divisions)) {
    tables[league] = newTable(teams.map(prepareTeam));
    schedules[league] = makeSchedule(teams.map(t => t.id));
  }
  return {tables, schedules};
}
function team(league, id){
  return state.divisions[league]?.find(t => t.id === id) || {id, name:id, rating:70, reputation:3, form:0};
}
function maxRounds(){ return Math.max(0, ...Object.values(state.schedules).map(s => s.length)); }
function currentRoundMatches(){
  const out = [];
  for (const league of Object.keys(state.schedules)) {
    const round = state.schedules[league][state.round] || [];
    round.forEach(([homeId, awayId]) => out.push({league, home:team(league, homeId), away:team(league, awayId)}));
  }
  return out;
}
function simMatch(home, away){
  const h = effectiveRating(home);
  const a = effectiveRating(away);
  const diff = h - a;
  const pace = rand(0.86, 1.14);
  const homeAttack = clamp(1.22 + diff / 42 + 0.23, 0.25, 3.25) * pace;
  const awayAttack = clamp(1.02 - diff / 46, 0.20, 2.85) * pace;
  let hg = poisson(homeAttack);
  let ag = poisson(awayAttack);
  if (Math.random() < 0.045) hg += 1;
  if (Math.random() < 0.035) ag += 1;
  return [clamp(hg, 0, 7), clamp(ag, 0, 7)];
}
function bumpForm(teamObj, result){
  const delta = result === 'W' ? rand(0.2, 0.8) : result === 'L' ? -rand(0.2, 0.8) : rand(-0.15, 0.25);
  teamObj.form = clamp(Number(teamObj.form || 0) + delta, -5, 5);
}
function applyResult(league, home, away, hg, ag){
  const table = state.tables[league];
  const h = table[home.id], a = table[away.id];
  if (!h || !a) return;
  h.played++; a.played++;
  h.goalsFor += hg; h.goalsAgainst += ag;
  a.goalsFor += ag; a.goalsAgainst += hg;
  h.goalDifference = h.goalsFor - h.goalsAgainst;
  a.goalDifference = a.goalsFor - a.goalsAgainst;
  if (hg > ag) { h.won++; a.lost++; h.points += 3; bumpForm(home, 'W'); bumpForm(away, 'L'); }
  else if (ag > hg) { a.won++; h.lost++; a.points += 3; bumpForm(away, 'W'); bumpForm(home, 'L'); }
  else { h.drawn++; a.drawn++; h.points++; a.points++; bumpForm(home, 'D'); bumpForm(away, 'D'); }
}
function leagueMovementInfo(league, rowIndex, rowCount){
  const leagues = state.config.leagues;
  const idx = leagues.indexOf(league);
  const canPromote = idx > 0;
  const canRelegate = idx < leagues.length - 1;
  const promotionCount = canPromote ? Math.min(PROMOTION_SLOTS, rowCount) : 0;
  const relegationCount = canRelegate ? Math.min(RELEGATION_SLOTS, Math.max(0, rowCount - promotionCount)) : 0;
  if (canPromote && rowIndex < promotionCount) return {className:'pos-promo', icon:'fa-arrow-up', title:`Sobe para ${leagues[idx-1]}`};
  if (canRelegate && rowIndex >= rowCount - relegationCount) return {className:'pos-releg', icon:'fa-arrow-down', title:`Cai para ${leagues[idx+1]}`};
  return {className:'', icon:'fa-minus', title:'Permanece'};
}
function renderNav(){
  const nav = document.getElementById('league-nav');
  nav.innerHTML = state.config.leagues.map(l => `<div class="nav-item ${l===activeLeague?'active':''}" data-league="${escapeHTML(l)}"><i class="fa-solid fa-layer-group"></i>${escapeHTML(l)} <span class="muted">${state.divisions[l]?.length || 0}</span></div>`).join('');
  nav.querySelectorAll('[data-league]').forEach(el => el.onclick = () => { activeLeague = el.dataset.league; render(); });
}
function renderTable(){
  const tbody = document.getElementById('tbody');
  const rows = sortTable(state.tables[activeLeague] || {});
  document.getElementById('view-title').textContent = activeLeague || 'Classificação';
  const idx = state.config.leagues.indexOf(activeLeague);
  const notes = [];
  if (idx > 0) notes.push(`${PROMOTION_SLOTS} sobem`);
  if (idx < state.config.leagues.length - 1) notes.push(`${RELEGATION_SLOTS} caem`);
  document.getElementById('league-note').textContent = notes.length ? notes.join(' • ') : 'Divisão principal';
  tbody.innerHTML = rows.map((t,i) => {
    const mv = leagueMovementInfo(activeLeague, i, rows.length);
    return `<tr class="${mv.className}"><td class="pos-col">${i+1}</td><td class="club-col"><strong>${escapeHTML(t.name)}</strong></td><td>${t.points}</td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.goalsFor}</td><td>${t.goalsAgainst}</td><td class="${t.goalDifference>0?'good':t.goalDifference<0?'bad':''}">${t.goalDifference}</td><td class="status-col" title="${escapeHTML(mv.title)}"><i class="fa-solid ${mv.icon}"></i></td></tr>`;
  }).join('') || '<tr><td colspan="11">Sem times nesta divisão.</td></tr>';
}
function renderResults(){
  const box = document.getElementById('results');
  const latest = state.results.slice(-50).reverse();
  box.innerHTML = latest.length ? latest.map(r => `<div class="score-card"><div class="score-row"><span class="muted">${escapeHTML(r.league)} • Rodada ${r.round}</span><span class="score">${escapeHTML(r.home)} ${r.homeGoals} × ${r.awayGoals} ${escapeHTML(r.away)}</span></div></div>`).join('') : '<p class="muted">Nenhum resultado ainda.</p>';
}
function renderHistory(){
  const box = document.getElementById('history');
  const movementBlock = (state.lastMovements || []).length ? `<div class="notice"><strong>Movimentações da última temporada</strong>${state.lastMovements.map(m => `<p class="muted"><i class="fa-solid ${m.type==='promotion'?'fa-arrow-up good':'fa-arrow-down bad'}"></i> ${escapeHTML(m.team)}: ${escapeHTML(m.from)} → ${escapeHTML(m.to)}</p>`).join('')}</div>` : '';
  const historyBlock = state.history.length ? state.history.map(h => `<div class="save-card"><strong>Temporada ${h.season}</strong>${Object.entries(h.winners).map(([l,w]) => `<p class="muted">${escapeHTML(l)}: ${escapeHTML(w)}</p>`).join('')}</div>`).join('') : '<p class="muted">Nenhuma temporada concluída.</p>';
  box.innerHTML = movementBlock + historyBlock;
}
function render(){
  document.getElementById('zone').textContent = state.zone;
  document.getElementById('season').textContent = 'Temporada ' + state.season;
  document.getElementById('round').textContent = `Rodada ${state.round}/${maxRounds()}`;
  document.getElementById('dash-zone').textContent = state.zone;
  document.getElementById('dash-season').textContent = state.season;
  document.getElementById('dash-round').textContent = `${state.round}/${maxRounds()}`;
  const done = state.round >= maxRounds();
  document.getElementById('sim-round').innerHTML = done ? '<i class="fa-solid fa-flag-checkered"></i>Encerrar temporada' : '<i class="fa-solid fa-forward-step"></i>Simular rodada';
  renderNav(); renderTable(); renderResults(); renderHistory();
}
function simulateRound(){
  const matches = currentRoundMatches();
  if (!matches.length) { finishSeason(); return; }
  matches.forEach(m => {
    const [homeGoals, awayGoals] = simMatch(m.home, m.away);
    applyResult(m.league, m.home, m.away, homeGoals, awayGoals);
    state.results.push({round:state.round+1, league:m.league, home:m.home.name, away:m.away.name, homeGoals, awayGoals});
  });
  state.round++;
  render();
}
function finishSeason(){
  const leagues = state.config.leagues;
  const winners = {};
  const sorted = {};
  leagues.forEach(l => { sorted[l] = sortTable(state.tables[l] || {}); winners[l] = sorted[l][0]?.name || '-'; });

  const nextDivisions = {};
  const movements = [];
  leagues.forEach((league, idx) => {
    const rows = sorted[league] || [];
    const canPromote = idx > 0;
    const canRelegate = idx < leagues.length - 1;
    const up = canPromote ? rows.slice(0, PROMOTION_SLOTS).map(stripStats) : [];
    const down = canRelegate ? rows.slice(-RELEGATION_SLOTS).map(stripStats) : [];
    const stayStart = canPromote ? PROMOTION_SLOTS : 0;
    const stayEnd = canRelegate ? Math.max(stayStart, rows.length - RELEGATION_SLOTS) : rows.length;
    nextDivisions[league] = rows.slice(stayStart, stayEnd).map(stripStats);
    up.forEach(t => movements.push({type:'promotion', team:t.name, from:league, to:leagues[idx-1]}));
    down.forEach(t => movements.push({type:'relegation', team:t.name, from:league, to:leagues[idx+1]}));
  });
  leagues.forEach((league, idx) => {
    if (idx > 0) nextDivisions[league].push(...(sorted[leagues[idx-1]] || []).slice(-RELEGATION_SLOTS).map(stripStats));
    if (idx < leagues.length - 1) nextDivisions[league].push(...(sorted[leagues[idx+1]] || []).slice(0, PROMOTION_SLOTS).map(stripStats));
  });

  state.history.push({season:state.season, winners, movements});
  state.season++;
  state.round = 0;
  state.divisions = nextDivisions;
  const built = buildSeason(state.divisions);
  state.tables = built.tables;
  state.schedules = built.schedules;
  state.results = [];
  state.lastMovements = movements;
  alert('Temporada encerrada. Promoções e rebaixamentos aplicados.');
  render();
}
function stripStats(t){
  const rep = clamp(Number(t.reputation || 1), 1, 7);
  const ratingDrift = rand(-2, 2) + (rep - 4) * 0.15;
  return {
    id:t.id, name:t.name, city:t.city || '', state:t.state || '', reputation:rep,
    rating:clamp(Math.round(Number(t.rating || generateRatingFromReputation(rep)) + ratingDrift), 35, 99),
    form:0
  };
}
function simulateSeason(){
  while (state.round < maxRounds()) {
    const matches = currentRoundMatches();
    if (!matches.length) break;
    matches.forEach(m => {
      const [homeGoals, awayGoals] = simMatch(m.home, m.away);
      applyResult(m.league, m.home, m.away, homeGoals, awayGoals);
      state.results.push({round:state.round+1, league:m.league, home:m.home.name, away:m.away.name, homeGoals, awayGoals});
    });
    state.round++;
  }
  finishSeason();
}
function saveGame(){ state.updatedAt = new Date().toISOString(); upsertSave(state); alert('Save gravado no navegador.'); render(); }
function showPanel(id){
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('[data-panel]').forEach(n => n.classList.toggle('active', n.dataset.panel === id));
}
async function init(){
  if (params.get('save')) state = getSaves().find(s => s.id === params.get('save')) || null;
  if (!state) {
    let cfg = await loadDefaultConfig();
    const pending = sessionStorage.getItem('avanci_pending_config');
    if (pending) { cfg = JSON.parse(pending); sessionStorage.removeItem('avanci_pending_config'); }
    const errors = validateConfig(normalizeConfig(cfg));
    if (errors.length) alert('Configuração inicial inválida: ' + errors.join(' '));
    const shouldShuffle = confirm('Deseja embaralhar os times antes de dividir as ligas?');
    state = createGame(cfg, shouldShuffle);
  }
  state.config = normalizeConfig(state.config || await loadDefaultConfig());
  state.divisions = state.divisions || splitTeams(state.config, false);
  Object.keys(state.divisions).forEach(l => state.divisions[l] = state.divisions[l].map(prepareTeam));
  if (!state.tables || !state.schedules) { const built = buildSeason(state.divisions); state.tables = built.tables; state.schedules = built.schedules; }
  activeLeague = state.config.leagues[0];
  document.getElementById('sim-round').onclick = simulateRound;
  document.getElementById('sim-season').onclick = simulateSeason;
  document.getElementById('save').onclick = saveGame;
  document.getElementById('export').onclick = () => downloadJSON(`${state.id}.json`, state);
  document.getElementById('import').onchange = async e => {
    if (!e.target.files[0]) return;
    try { state = await readJSONFile(e.target.files[0]); activeLeague = state.config?.leagues?.[0] || Object.keys(state.divisions || {})[0]; render(); }
    catch(err) { alert('Save inválido: ' + err.message); }
  };
  document.querySelectorAll('[data-panel]').forEach(n => n.onclick = () => showPanel(n.dataset.panel));
  render();
}
window.addEventListener('DOMContentLoaded', init);
