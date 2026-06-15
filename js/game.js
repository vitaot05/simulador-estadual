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

const POSITIONS=['GOL','ZAG','LAT','VOL','MEC','MEI','PNT','ATA'];
const DEFAULT_FORMATION=['GOL','LAT','ZAG','ZAG','LAT','VOL','MEC','MEI','PNT','ATA','ATA'];
const POSITION_GOAL_WEIGHTS={GOL:0,ZAG:.08,LAT:.12,VOL:.18,MEC:.28,MEI:.50,PNT:.72,ATA:1};
const POSITION_ASSIST_WEIGHTS={GOL:0,ZAG:.10,LAT:.34,VOL:.30,MEC:.46,MEI:.80,PNT:.78,ATA:.38};
const NATIONALITIES=['br','ar','uy','co','py','cl','ec','pe','ve','bo','us','pt','es','it'];
const REGEN_FIRST=['Lucas','Gabriel','João','Pedro','Matheus','Rafael','Bruno','Felipe','Caio','Thiago','Vitor','André'];
const REGEN_LAST=['Silva','Santos','Oliveira','Souza','Costa','Pereira','Lima','Alves','Ribeiro','Gomes','Rocha','Barbosa'];
function normalizePosition(pos, idx=0){
  const raw=String(pos||'').toUpperCase();
  const map={GOLEIRO:'GOL',GK:'GOL',GOALKEEPER:'GOL',OUTFIELD:DEFAULT_FORMATION[idx]||'ATA',CB:'ZAG',ZAGUEIRO:'ZAG',DF:'ZAG',LB:'LAT',RB:'LAT',LATERAL:'LAT',DM:'VOL',VOLANTE:'VOL',CM:'MEC',MC:'MEC',MEC:'MEC',AM:'MEI',MEIA:'MEI',MEI:'MEI',W:'PNT',WINGER:'PNT',PONTA:'PNT',PNT:'PNT',FW:'ATA',ST:'ATA',STRIKER:'ATA',ATACANTE:'ATA',ATA:'ATA'};
  return POSITIONS.includes(raw) ? raw : (map[raw] || DEFAULT_FORMATION[idx] || 'ATA');
}
function playerBase(teamRep, player){
  const rep=clamp(Number(teamRep||3),1,7);
  const base={1:42,2:50,3:58,4:66,5:74,6:82,7:89}[rep] || 60;
  const statusBonus=player.status==='starter' ? rand(2,7) : rand(-8,-1);
  const repBonus=player.reputation==='world_star' ? rand(8,13) : player.reputation==='star' ? rand(4,8) : rand(-2,3);
  const age=Number(player.age||25);
  const ageBonus=age>=24&&age<=31 ? rand(0,3) : age<21 ? rand(-3,2) : rand(-4,1);
  return clamp(Math.round(base + statusBonus + repBonus + ageBonus), 35, 99);
}
function sanitizePlayer(p, teamRep=3, idx=0){
  const position=normalizePosition(p.position, idx);
  const status=['starter','substitute'].includes(String(p.status)) ? String(p.status) : (idx<11?'starter':'substitute');
  const reputation=['normal','star','world_star'].includes(p.reputation) ? p.reputation : 'normal';
  const clean={name:String(p.name||`Player ${idx+1}`), nationality:String(p.nationality||'br').toLowerCase(), age:clamp(Number(p.age||25),15,50), position, status, reputation};
  clean.rating=Number(p.rating||playerBase(teamRep, clean));
  clean.stamina=clamp(Number(p.stamina ?? 100),0,100);
  clean.marketValue=Number(p.marketValue||playerValue(clean));
  clean.loanFrom=p.loanFrom||null;
  clean.loanUntil=p.loanUntil||null;
  clean.seasonForm=Number(p.seasonForm||0);
  return clean;
}

function playerValue(player){
  const repMult=player.reputation==='world_star'?2.4:player.reputation==='star'?1.65:1;
  const age=Number(player.age||25);
  const ageMult=age<21?1.25:age<=27?1.45:age<=31?1.1:age<=34?.75:.35;
  const rating=Math.max(35, Number(player.rating||60));
  return Math.round((rating*rating*900) * repMult * ageMult / 1000) * 1000;
}
function positionWeight(player, mode='goal'){
  const table = mode==='assist' ? POSITION_ASSIST_WEIGHTS : POSITION_GOAL_WEIGHTS;
  return table[normalizePosition(player.position)] ?? .25;
}
function matchSquad(teamObj){
  const players=(teamObj.players||[]).map((p,i)=>sanitizePlayer(p,teamObj.reputation,i));
  if(!players.length) return {starters:[], bench:[]};
  const score=p=>(Number(p.rating||60)*(.72+.28*(Number(p.stamina??100)/100))) + (p.status==='starter'?3:0);
  const starters=[];
  const keepers=players.filter(p=>p.position==='GOL').sort((a,b)=>score(b)-score(a));
  if(keepers[0]) starters.push(keepers[0]);
  for(const pos of ['ZAG','ZAG','LAT','LAT','VOL','MEC','MEI','PNT','ATA','ATA']){
    const pool=players.filter(p=>!starters.includes(p) && p.position===pos).sort((a,b)=>score(b)-score(a));
    if(pool[0]) starters.push(pool[0]);
  }
  players.filter(p=>!starters.includes(p)).sort((a,b)=>score(b)-score(a)).forEach(p=>{ if(starters.length<11) starters.push(p); });
  const bench=players.filter(p=>!starters.includes(p)).sort((a,b)=>score(b)-score(a)).slice(0,9);
  let substitutions=0;
  for(let i=0;i<starters.length && substitutions<5;i++){
    const s=starters[i];
    const needRest = Number(s.stamina||100)<58 || (Number(s.age||25)>32 && Math.random()<.28);
    if(!needRest) continue;
    const replIndex=bench.findIndex(b=>b.position===s.position || (s.position!=='GOL' && b.position!=='GOL'));
    if(replIndex>=0){ const repl=bench.splice(replIndex,1)[0]; bench.push(s); starters[i]=repl; substitutions++; }
  }
  return {starters, bench, substitutions};
}
function applyFatigueAndRecovery(teamObj, usedPlayers=[]){
  const used=new Set(usedPlayers.map(p=>p.name));
  (teamObj.players||[]).forEach(p=>{
    const age=Number(p.age||25);
    const loss=used.has(p.name) ? rand(9,15) + Math.max(0, age-30)*.9 : -rand(5,10);
    p.stamina=clamp(Math.round(Number(p.stamina??100)-loss), 35, 100);
  });
}

function teamRatingFromPlayers(team){
  const squad=matchSquad(team);
  const base=squad.starters.length?squad.starters:(team.players||[]).map((p,i)=>sanitizePlayer(p, team.reputation, i)).slice(0,11);
  if(!base.length) return generateRatingFromReputation(team.reputation||3);
  return clamp(Math.round(base.reduce((sum,p)=>sum + Number(p.rating||60)*(.82+.18*(Number(p.stamina??100)/100)),0)/base.length),35,99);
}
function sanitizeTeam(t){
  const reputation=clamp(Number(t.reputation||1),1,7);
  const players=Array.isArray(t.players) ? t.players.map((p,i)=>sanitizePlayer(p,reputation,i)) : [];
  const base={id:t.id, name:t.name, reputation, players, form:Number(t.form||0)};
  base.rating=Number(t.rating||teamRatingFromPlayers(base));
  return base;
}
function effectiveRating(t){ return clamp(teamRatingFromPlayers(t) + Number(t.form||0), 35, 99); }
function allTeams(){ return Object.values(game.divisions||{}).flat().map(sanitizeTeam); }
function findTeam(id){ return allTeams().find(t=>t.id===id) || {id,name:id,rating:70,reputation:3,form:0}; }
function team(league,id){ return game.divisions[league]?.find(t=>t.id===id) || findTeam(id); }
function maxRounds(){ return Math.max(0, ...Object.values(game.schedules||{}).map(s=>s.length)); }
function cupSize(total){ if(total>=64)return 64; if(total>=32)return 32; if(total>=16)return 16; if(total>=8)return 8; return 0; }
function cupRoundName(size, remaining){ if(remaining===2)return 'Final'; if(remaining===4)return 'Semifinal'; if(remaining===8)return 'Quartas'; if(remaining===16)return 'Oitavas'; return `${remaining/2}ª fase`; }
function cupRoundCount(){ return game?.cup?.size ? Math.log2(game.cup.size) : 0; }
function nextActionLabel(){
  return game.round>=maxRounds() && (!game.cup?.size || game.cup?.winner) ? 'Próxima temporada' : 'Avançar';
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
  Object.values(divisions).flat().forEach(normalizeSquadStatuses);
  const built = buildSeason(divisions);
  const g = {id:'slot_'+slot, slot:Number(slot), name:`Slot ${slot} • ${cfg.zone}`, config:cfg, zone:cfg.zone, season:2026, round:0, divisions, tables:built.tables, schedules:built.schedules, results:[], cupResults:[], history:[], museum:{}, playerStats:{competitions:{}, total:{}}, awards:[], transferHistory:[], lastTransfers:[], lastMovements:[], cup:null, supercup:null, phase:'league', pendingSupercup:null, updatedAt:new Date().toISOString()};
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
  const players=Array.isArray(t.players) ? t.players.map((p,i)=>({...sanitizePlayer(p,rep,i), seasonForm:0})) : [];
  const rating=players.length ? teamRatingFromPlayers({reputation:rep,players}) : clamp(Math.round(Number(t.rating||generateRatingFromReputation(rep))+rand(-2,2)),35,99);
  return {id:t.id, name:t.name, reputation:rep, rating, players, form:0};
}
function addTitle(teamName, competition){
  if(!teamName || teamName==='-') return;
  const key=teamName.toLowerCase();
  game.museum ||= {};
  game.museum[key] ||= {team:teamName,total:0,byCompetition:{},byLeague:{},seasonsByCompetition:{}};
  const entry=game.museum[key];
  entry.byCompetition ||= {}; entry.byLeague ||= {}; entry.seasonsByCompetition ||= {};
  entry.total++;
  entry.byCompetition[competition]=(entry.byCompetition[competition]||0)+1;
  entry.byLeague[competition]=(entry.byLeague[competition]||0)+1;
  entry.seasonsByCompetition[competition] ||= [];
  if(!entry.seasonsByCompetition[competition].includes(game.season)) entry.seasonsByCompetition[competition].push(game.season);
}

function statKey(teamObj, player){ return `${teamObj.id}::${player.name}`; }
function ensurePlayerStat(bucket, teamObj, player){
  const key=statKey(teamObj, player);
  bucket[key] ||= {player:player.name, team:teamObj.name, teamId:teamObj.id, position:player.position, goals:0, assists:0, cleanSheets:0, ratingPoints:0, matches:0};
  return bucket[key];
}
function addStat(competition, teamObj, player, stat, value=1){
  if(!player) return;
  game.playerStats ||= {competitions:{}, total:{}};
  game.playerStats.competitions[competition] ||= {};
  [game.playerStats.total, game.playerStats.competitions[competition]].forEach(bucket=>{
    const row=ensurePlayerStat(bucket, teamObj, player);
    row[stat]=(row[stat]||0)+value;
  });
}
function rateAppearance(competition, teamObj, player, points){
  game.playerStats ||= {competitions:{}, total:{}};
  game.playerStats.competitions[competition] ||= {};
  [game.playerStats.total, game.playerStats.competitions[competition]].forEach(bucket=>{
    const row=ensurePlayerStat(bucket, teamObj, player);
    row.matches++;
    row.ratingPoints += points;
  });
}
function weightedPlayer(teamObj, filter, mode='goal'){
  const players=(teamObj.players||[]).filter(filter);
  if(!players.length) return null;
  const weight=p=>Math.max(.01, positionWeight(p,mode))*Math.max(1,Number(p.rating||60))*(p.status==='starter'?1.25:.65)*(p.reputation==='world_star'?1.5:p.reputation==='star'?1.25:1);
  const total=players.reduce((sum,p)=>sum+weight(p),0);
  let pick=Math.random()*total;
  for(const p of players){ pick-=weight(p); if(pick<=0)return p; }
  return players[0];
}
function registerMatchStats(competition, homeTeam, awayTeam, hg, ag){
  const outfield=p=>p.position!=='GOL';
  const keeper=p=>p.position==='GOL';
  const hs=matchSquad(homeTeam); const as=matchSquad(awayTeam);
  hs.starters.forEach(p=>rateAppearance(competition,homeTeam,p, p.position==='GOL' ? (ag===0?7:5) : 5 + (hg>ag?1:0)));
  as.starters.forEach(p=>rateAppearance(competition,awayTeam,p, p.position==='GOL' ? (hg===0?7:5) : 5 + (ag>hg?1:0)));
  applyFatigueAndRecovery(homeTeam, hs.starters); applyFatigueAndRecovery(awayTeam, as.starters);
  for(let i=0;i<hg;i++){
    const scorer=weightedPlayer(homeTeam,outfield,'goal'); addStat(competition,homeTeam,scorer,'goals'); rateAppearance(competition,homeTeam,scorer,2.8);
    if(Math.random()<.72){ const assist=weightedPlayer(homeTeam,p=>outfield(p) && p.name!==scorer?.name,'assist'); addStat(competition,homeTeam,assist,'assists'); rateAppearance(competition,homeTeam,assist,1.8); }
  }
  for(let i=0;i<ag;i++){
    const scorer=weightedPlayer(awayTeam,outfield,'goal'); addStat(competition,awayTeam,scorer,'goals'); rateAppearance(competition,awayTeam,scorer,2.8);
    if(Math.random()<.72){ const assist=weightedPlayer(awayTeam,p=>outfield(p) && p.name!==scorer?.name,'assist'); addStat(competition,awayTeam,assist,'assists'); rateAppearance(competition,awayTeam,assist,1.8); }
  }
  if(ag===0) addStat(competition,homeTeam,weightedPlayer(homeTeam,keeper,'goal'),'cleanSheets');
  if(hg===0) addStat(competition,awayTeam,weightedPlayer(awayTeam,keeper,'goal'),'cleanSheets');
}
function rowsFromStats(bucket, stat, onlyKeepers=false){
  return Object.values(bucket||{}).filter(r=>!onlyKeepers || r.position==='GOL').sort((a,b)=>(b[stat]||0)-(a[stat]||0) || (b.ratingPoints||0)-(a.ratingPoints||0) || a.player.localeCompare(b.player)).slice(0,15);
}
function computeAwards(){
  const rows=Object.values(game.playerStats?.total||{});
  const player=rows.filter(r=>r.position!=='GOL').sort((a,b)=>(b.ratingPoints||0)-(a.ratingPoints||0) || (b.goals||0)-(a.goals||0))[0] || null;
  const keeper=rows.filter(r=>r.position==='GOL').sort((a,b)=>(b.cleanSheets||0)-(a.cleanSheets||0) || (b.ratingPoints||0)-(a.ratingPoints||0))[0] || null;
  return {season:game.season, bestPlayer:player?{player:player.player,team:player.team}:null, bestGoalkeeper:keeper?{player:keeper.player,team:keeper.team}:null};
}

function playerSeasonRow(player, teamObj){
  const key=statKey(teamObj, player);
  return game.playerStats?.total?.[key] || null;
}
function developPlayersAndRegens(divisions){
  const regens=[];
  Object.values(divisions).flat().forEach(teamObj=>{
    teamObj.players=(teamObj.players||[]).filter((p,idx)=>{
      const row=playerSeasonRow(p, teamObj) || {matches:0, goals:0, assists:0, cleanSheets:0, ratingPoints:0};
      const oldAge=Number(p.age||25);
      p.age=oldAge+1;
      const avg=row.matches ? row.ratingPoints/row.matches : 0;
      let delta=0;
      if(p.age<=22 && (row.goals+row.assists+row.cleanSheets>=3 || avg>=6.4)) delta+=Math.round(rand(1,3));
      if(p.age>=23 && p.age<=28 && avg>=7.0) delta+=Math.random()<.6?1:0;
      if(p.age>=31 && (avg<5.8 || row.matches<8)) delta-=Math.round(rand(1,3));
      if(p.age>=35) delta-=Math.round(rand(1,2));
      p.rating=clamp(Number(p.rating||60)+delta,35,99);
      p.marketValue=playerValue(p);
      p.stamina=100;
      const retire = p.age>=39 || (p.age>=36 && p.rating<58 && Math.random()<.40) || (p.age>=34 && row.matches<4 && Math.random()<.08);
      if(retire){ regens.push(makeRegenFrom(p)); return false; }
      return true;
    });
  });
  const all=Object.values(divisions).flat();
  regens.forEach(r=>{ const t=all[Math.floor(Math.random()*all.length)]; if(t){ t.players ||= []; t.players.push(r); }});
  return regens;
}
function makeRegenFrom(p){
  const first=REGEN_FIRST[Math.floor(Math.random()*REGEN_FIRST.length)];
  const last=REGEN_LAST[Math.floor(Math.random()*REGEN_LAST.length)];
  const age=Math.random()<.5?17:18;
  const rating=clamp(Math.round(Number(p.rating||60)-rand(14,24)),35,72);
  return {name:`${first} ${last}`, nationality:p.nationality||'br', age, position:normalizePosition(p.position), status:'substitute', reputation:'normal', rating, stamina:100, marketValue:0};
}
function restoreLoans(divisions){
  const teams=Object.values(divisions).flat();
  const byId=Object.fromEntries(teams.map(t=>[t.id,t]));
  teams.forEach(t=>{
    const keep=[];
    (t.players||[]).forEach(p=>{
      if(p.loanFrom && Number(p.loanUntil||0)<=Number(game.season)){
        const origin=byId[p.loanFrom];
        if(origin){ delete p.loanFrom; delete p.loanUntil; origin.players ||= []; origin.players.push(p); }
        else keep.push(p);
      } else keep.push(p);
    });
    t.players=keep;
  });
}
function positionalNeeds(teamObj){
  const target={GOL:2,ZAG:4,LAT:4,VOL:2,MEC:2,MEI:2,PNT:2,ATA:3};
  const counts={}; (teamObj.players||[]).forEach(p=>counts[normalizePosition(p.position)]=(counts[normalizePosition(p.position)]||0)+1);
  return Object.entries(target).filter(([pos,n])=>(counts[pos]||0)<n).map(([pos])=>pos);
}
function teamBudget(teamObj){
  const rep=clamp(Number(teamObj.reputation||3),1,7);
  return Number(teamObj.budget ?? (rep*rep*4200000 + rand(1000000,9000000)));
}
function randomFreeAgent(pos, rep=3){
  const first=REGEN_FIRST[Math.floor(Math.random()*REGEN_FIRST.length)];
  const last=REGEN_LAST[Math.floor(Math.random()*REGEN_LAST.length)];
  const age=Math.round(rand(18,31));
  const rating=clamp(Math.round({1:45,2:51,3:57,4:63,5:69,6:74,7:78}[rep] + rand(-8,8)),35,86);
  return {name:`${first} ${last}`, nationality:NATIONALITIES[Math.floor(Math.random()*NATIONALITIES.length)], age, position:pos, status:'substitute', reputation:'normal', rating, stamina:100, marketValue:0};
}
function performTransferWindow(divisions){
  restoreLoans(divisions);
  const teams=Object.values(divisions).flat();
  const records=[];
  teams.forEach(t=>{ t.budget=teamBudget(t); (t.players||[]).forEach((p,i)=>{ p.marketValue=playerValue(p); if(i>=11 && p.status==='starter') p.status='substitute'; }); });
  teams.forEach(buyer=>{
    const needs=positionalNeeds(buyer).slice(0,3);
    needs.forEach(pos=>{
      const candidates=[];
      teams.filter(t=>t.id!==buyer.id).forEach(seller=>{
        const surplus=(seller.players||[]).filter(p=>normalizePosition(p.position)===pos && p.status==='substitute' && !p.loanFrom && Number(p.transferredSeason||0)!==Number(game.season));
        surplus.forEach(p=>candidates.push({seller,p}));
      });
      const picked=candidates.sort((a,b)=>Number(a.p.marketValue||0)-Number(b.p.marketValue||0))[0];
      const isLoan=Math.random()<.32;
      if(picked && (isLoan || Number(buyer.budget||0) >= Number(picked.p.marketValue||0)*.75)){
        const price=Math.max(100000, Math.round(Number(picked.p.marketValue||0)*(isLoan?0.12:rand(.72,1.15))));
        picked.seller.players=picked.seller.players.filter(x=>x!==picked.p);
        picked.p.transferredSeason = game.season;
        if(isLoan){ picked.p.loanFrom=picked.seller.id; picked.p.loanUntil=game.season+1; }
        buyer.players.push(picked.p);
        if(!isLoan){ buyer.budget-=price; picked.seller.budget=Number(picked.seller.budget||0)+price; }
        records.push({season:game.season,type:isLoan?'loan':'transfer',player:picked.p.name,position:pos,from:picked.seller.name,to:buyer.name,value:price});
      } else if(Math.random()<.45){
        const p=randomFreeAgent(pos,buyer.reputation); p.marketValue=playerValue(p); p.transferredSeason=game.season; buyer.players.push(p);
        records.push({season:game.season,type:'free',player:p.name,position:pos,from:'Livre',to:buyer.name,value:0});
      }
    });
  });
  game.transferHistory ||= [];
  game.transferHistory.push(...records);
  return records;
}
function normalizeSquadStatuses(teamObj){
  const squad=matchSquad(teamObj);
  (teamObj.players||[]).forEach(p=>p.status=squad.starters.some(s=>s.name===p.name)?'starter':'substitute');
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
function competitionTitle(name){
  return '';
}
function renderCompetition(){
  const box=document.getElementById('competition-view');
  if(!box) return;
  const comp=activeCompetition;
  const season=currentViewSeason();
  if(isLeagueCompetition(comp)){
    const finals=finalTablesForSeason(season);
    if(Number(season)!==Number(game.season)){
      box.innerHTML = finals?.[comp] ? competitionTitle(comp) + renderMiniTable('', finals[comp]||[]) : '<p class="empty-text">Sem tabela final para esta temporada.</p>';
    } else {
      box.innerHTML=competitionTitle(comp)+standingsTable(comp);
    }
    return;
  }
  if(isCupCompetition(comp)){
    const cupList=cupResultsForSeason(season);
    if(cupList.length){
      const grouped={}; cupList.forEach(r=>{ (grouped[r.name || comp] ||= []).push(r); });
      const keys=sortedCupPhaseNames(grouped);
      box.innerHTML = `<div class="results-stack cup-stack">${keys.map(name=>`<section class="round-results"><h3>${escapeHTML(name)}</h3><div class="results-list">${grouped[name].map(matchLine).join('')}</div></section>`).join('')}</div>`;
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
function cupPhaseOrder(name){
  const n=String(name||'').toLowerCase();
  if(n.includes('final')) return 100;
  if(n.includes('semifinal')) return 90;
  if(n.includes('quartas')) return 80;
  if(n.includes('oitavas')) return 70;
  const m=n.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
function sortedCupPhaseNames(grouped){
  return Object.keys(grouped).sort((a,b)=>cupPhaseOrder(b)-cupPhaseOrder(a));
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
  const title = league ? `<h3>${escapeHTML(league)}</h3>` : '';
  return `<section class="result-section">${title}<div class="tbl-wrap compact"><table><thead><tr><th class="pos-col">#</th><th class="club-col">Clube</th><th>Pts</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th></tr></thead><tbody>${rows.map((t,i)=>`<tr><td class="pos-col">${i+1}</td><td class="club-col">${escapeHTML(t.name)}</td><td class="pts">${t.points}</td><td>${t.played}</td><td>${t.won}</td><td>${t.drawn}</td><td>${t.lost}</td><td>${t.goalDifference}</td></tr>`).join('')}</tbody></table></div></section>`;
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
    const phases=sortedCupPhaseNames(byPhase);
    html = phases.length ? `<div class="results-stack cup-stack">${phases.map(name=>`<section class="round-results"><h3>${escapeHTML(name)}</h3><div class="results-list">${byPhase[name].map(matchLine).join('')}</div></section>`).join('')}</div>` : '<p class="empty-text">Sem resultados.</p>';
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
  box.innerHTML = `<div class="calendar-grid">${events.map((it,idx)=>`<button class="calendar-day ${it.kind} ${it.status}" data-calendar-index="${idx}" title="Pular até esta semana"><span>${idx+1}</span><strong>${escapeHTML(it.title)}</strong><small>${escapeHTML(it.sub)}</small></button>`).join('')}</div>`;
  box.querySelectorAll('[data-calendar-index]').forEach(btn=>{
    btn.onclick=()=>skipToCalendarIndex(Number(btn.dataset.calendarIndex));
  });
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
function museumEntries(){
  const competitions=[...game.config.leagues, game.config.cup, game.config.supercup].filter(Boolean);
  const map={};
  const ensure=(team)=>{
    const key=String(team||'').toLowerCase();
    map[key] ||= {team, seasonsByCompetition:{}};
    return map[key];
  };
  Object.values(game.museum||{}).forEach(item=>{
    const entry=ensure(item.team);
    const seasons=item.seasonsByCompetition || {};
    Object.entries(seasons).forEach(([comp,years])=>{
      entry.seasonsByCompetition[comp] ||= new Set();
      (years||[]).forEach(y=>entry.seasonsByCompetition[comp].add(Number(y)));
    });
    // Compatibility with older saves that only had counts.
    Object.entries(item.byCompetition||{}).forEach(([comp,count])=>{
      entry.seasonsByCompetition[comp] ||= new Set();
      if(!entry.seasonsByCompetition[comp].size && count>0) entry.seasonsByCompetition[comp].add(Number(game.season));
    });
  });
  (game.history||[]).forEach(h=>{
    Object.entries(h.winners||{}).forEach(([comp,team])=>{ const e=ensure(team); e.seasonsByCompetition[comp] ||= new Set(); e.seasonsByCompetition[comp].add(Number(h.season)); });
    if(h.cupWinner){ const e=ensure(h.cupWinner); e.seasonsByCompetition[game.config.cup] ||= new Set(); e.seasonsByCompetition[game.config.cup].add(Number(h.season)); }
    if(h.supercupWinner){ const e=ensure(h.supercupWinner); e.seasonsByCompetition[game.config.supercup] ||= new Set(); e.seasonsByCompetition[game.config.supercup].add(Number(h.season)); }
  });
  return Object.values(map).map(e=>{
    const detail=competitions.map(comp=>{
      const years=[...(e.seasonsByCompetition[comp]||[])].sort((a,b)=>b-a);
      return years.length ? `${escapeHTML(comp)}: ${years.join(', ')}` : '';
    }).filter(Boolean);
    const total=competitions.reduce((sum,comp)=>sum + ((e.seasonsByCompetition[comp]||new Set()).size),0);
    return {...e,total,detail};
  }).filter(e=>e.total>0).sort((a,b)=>b.total-a.total || a.team.localeCompare(b.team));
}
function renderMuseum(){
  const box=document.getElementById('museum');
  const rows=museumEntries();
  const titleTable = rows.length ? `<div class="tbl-wrap compact museum-table"><table><thead><tr><th class="club-col">Clube</th><th>Total</th><th class="club-col">Títulos por temporada</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="club-col"><strong>${escapeHTML(r.team)}</strong></td><td class="pts">${r.total}</td><td class="club-col">${r.detail.map(d=>`<div class="museum-detail">${d}</div>`).join('')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum título registrado ainda.</p>';
  const awardsBySeason = new Map();
  [...(game.history||[]).map(h=>h.awards).filter(Boolean), ...(game.awards||[])]
    .filter(Boolean)
    .forEach(a=>{ if(a && a.season!=null) awardsBySeason.set(String(a.season), a); });
  const awards=[...awardsBySeason.values()].sort((a,b)=>Number(b.season)-Number(a.season));
  const awardsTable = awards.length ? `<section class="result-section"><h3>Premiações</h3><div class="tbl-wrap compact"><table><thead><tr><th>Temporada</th><th>Melhor jogador</th><th>Melhor goleiro</th></tr></thead><tbody>${awards.map(a=>`<tr><td>${a.season}</td><td>${escapeHTML(a.bestPlayer?.player||'-')} <span class="muted">${escapeHTML(a.bestPlayer?.team||'')}</span></td><td>${escapeHTML(a.bestGoalkeeper?.player||'-')} <span class="muted">${escapeHTML(a.bestGoalkeeper?.team||'')}</span></td></tr>`).join('')}</tbody></table></div></section>` : '';
  box.innerHTML = titleTable + awardsTable;
}


function statTable(title, rows, stat){
  if(!rows.length) return `<section class="result-section"><h3>${escapeHTML(title)}</h3><p class="empty-text">Sem dados.</p></section>`;
  return `<section class="result-section"><h3>${escapeHTML(title)}</h3><div class="tbl-wrap compact"><table><thead><tr><th class="pos-col">#</th><th class="club-col">Jogador</th><th>Clube</th><th>${stat==='goals'?'Gols':stat==='assists'?'Assist.':'CS'}</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td class="pos-col">${i+1}</td><td class="club-col"><strong>${escapeHTML(r.player)}</strong></td><td>${escapeHTML(r.team)}</td><td class="pts">${r[stat]||0}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function renderStats(){
  const box=document.getElementById('stats'); if(!box) return;
  const comp=activeCompetition;
  const compBucket=game.playerStats?.competitions?.[comp] || {};
  const totalBucket=game.playerStats?.total || {};
  box.innerHTML = `<div class="stats-grid">
    ${statTable(`Artilheiros · ${comp}`, rowsFromStats(compBucket,'goals'), 'goals')}
    ${statTable(`Assistências · ${comp}`, rowsFromStats(compBucket,'assists'), 'assists')}
    ${statTable(`Clean sheets · ${comp}`, rowsFromStats(compBucket,'cleanSheets',true), 'cleanSheets')}
    ${statTable('Artilheiros · Total', rowsFromStats(totalBucket,'goals'), 'goals')}
    ${statTable('Assistências · Total', rowsFromStats(totalBucket,'assists'), 'assists')}
    ${statTable('Clean sheets · Total', rowsFromStats(totalBucket,'cleanSheets',true), 'cleanSheets')}
  </div>`;
}

function transfersForSeason(season){
  return (game.transferHistory||[]).filter(t=>Number(t.season)===Number(season));
}
function renderTransfers(){
  const box=document.getElementById('transfers'); if(!box) return;
  const rows=transfersForSeason(currentViewSeason());
  if(!rows.length){ box.innerHTML='<p class="empty-text">Sem transferências registradas nesta temporada.</p>'; return; }
  box.innerHTML=`<div class="tbl-wrap compact"><table><thead><tr><th>Tipo</th><th class="club-col">Jogador</th><th>Pos</th><th>Origem</th><th>Destino</th><th>Valor</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.type==='loan'?'Empréstimo':r.type==='free'?'Livre':'Compra'}</td><td class="club-col"><strong>${escapeHTML(r.player)}</strong></td><td>${escapeHTML(r.position||'-')}</td><td>${escapeHTML(r.from||'-')}</td><td>${escapeHTML(r.to||'-')}</td><td>${r.value?('R$ '+Number(r.value).toLocaleString('pt-BR')):'-'}</td></tr>`).join('')}</tbody></table></div>`;
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
  const label=document.getElementById('week-label'); if(label) label.textContent=currentWeekLabel();
  const sim=document.getElementById('sim-round'); if(sim) sim.textContent = nextActionLabel();
}
function render(){
  syncSimulationMode();
  renderSeasonSelect(); renderCompetitionSelect(); renderCompetition(); renderResults(); renderCalendar(); renderMuseum(); renderStats(); renderTransfers(); renderSimulation(); renderSettings(); renderBottomNav();
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
  ctx.matches.forEach(m=>{ const h=team(m.league,m.homeId), a=team(m.league,m.awayId); registerMatchStats(m.league,h,a,m.homeGoals,m.awayGoals); applyResult(m.league,h,a,m.homeGoals,m.awayGoals); game.results.push({season:game.season, round:ctx.round, league:m.league, home:m.home, away:m.away, homeGoals:m.homeGoals, awayGoals:m.awayGoals}); });
  game.round++;
  game.phase = shouldInsertCupAfterLeague() ? 'cup' : 'league';
}
function commitCupSimulation(ctx){
  const cup=game.cup; const next=[];
  const matches=ctx.matches.map(m=>{ const ht=findTeam(m.homeId), at=findTeam(m.awayId); registerMatchStats(game.config.cup, ht, at, m.homeGoals, m.awayGoals); next.push(m.winnerId); return {season:game.season, name:ctx.roundName, home:m.home, away:m.away, homeGoals:m.homeGoals, awayGoals:m.awayGoals, penalties:m.penalties, winner:m.winner}; });
  cup.history.push({name:ctx.roundName, matches});
  game.cupResults.push(...matches);
  cup.roundIndex++;
  cup.participants=next;
  if(next.length===1){ cup.winner=findTeam(next[0]).name; const finalMatch=matches[0]; cup.runnerUp = finalMatch ? (finalMatch.winner===finalMatch.home ? finalMatch.away : finalMatch.home) : null; addTitle(cup.winner, game.config.cup); }
  game.phase='league';
}
function commitSupercupSimulation(ctx){
  const m=ctx.matches[0];
  const ht=findTeam(m.homeId), at=findTeam(m.awayId); registerMatchStats(game.config.supercup, ht, at, m.homeGoals, m.awayGoals); const res={season:game.season, home:m.home, away:m.away, homeGoals:m.homeGoals, awayGoals:m.awayGoals, penalties:m.penalties, winner:m.winner};
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
function commitNextInstant(){
  clearSimulationTimer();
  const ctx = buildSimulationContext();
  if(!ctx) return false;
  commitSimulation(ctx);
  return true;
}
function completedCalendarEvents(){
  return calendarEvents().filter(e=>e.status==='done').length;
}
function skipCurrentWeek(){
  clearSimulationTimer();
  simulationContext=null;
  commitNextInstant();
  syncSimulationMode();
  render();
}
function skipToCalendarIndex(targetIndex){
  if(!Number.isFinite(targetIndex)) return;
  const ok = confirm(`Simular automaticamente até a semana ${targetIndex+1}?`);
  if(!ok) return;
  clearSimulationTimer();
  simulationContext=null;
  let guard=0;
  while(completedCalendarEvents() <= targetIndex && guard < 250){
    const before = JSON.stringify({season:game.season, round:game.round, phase:game.phase, cup:game.cup?.history?.length, winner:game.cup?.winner, supercup:!!game.supercup});
    if(!commitNextInstant()) break;
    const after = JSON.stringify({season:game.season, round:game.round, phase:game.phase, cup:game.cup?.history?.length, winner:game.cup?.winner, supercup:!!game.supercup});
    guard++;
    if(before===after) break;
  }
  syncSimulationMode();
  showPanel('panel-calendar');
  render();
}
function beginSimulation(){
  simulateRound();
}
function stepSimulation(auto=false){
  simulateRound();
}
function simulateRound(){
  clearSimulationTimer();
  simulationContext=null;
  commitNextInstant();
  syncSimulationMode();
  render();
}
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
  const awards=computeAwards(); game.awards.push(awards);
  leagues.forEach((league,idx)=>{
    const rows=sorted[league]||[], canPromote=idx>0, canRelegate=idx<leagues.length-1;
    const stayStart=canPromote?PROMOTION_SLOTS:0, stayEnd=canRelegate?Math.max(stayStart, rows.length-RELEGATION_SLOTS):rows.length;
    nextDivisions[league]=rows.slice(stayStart,stayEnd).map(stripTeam);
    if(canPromote) rows.slice(0,PROMOTION_SLOTS).forEach(t=>movements.push({type:'promotion',team:t.name,from:league,to:leagues[idx-1]}));
    if(canRelegate) rows.slice(-RELEGATION_SLOTS).forEach(t=>movements.push({type:'relegation',team:t.name,from:league,to:leagues[idx+1]}));
  });
  leagues.forEach((league,idx)=>{ if(idx>0) nextDivisions[league].push(...(sorted[leagues[idx-1]]||[]).slice(-RELEGATION_SLOTS).map(stripTeam)); if(idx<leagues.length-1) nextDivisions[league].push(...(sorted[leagues[idx+1]]||[]).slice(0,PROMOTION_SLOTS).map(stripTeam)); });
  const regens=developPlayersAndRegens(nextDivisions);
  game.history.push({season:game.season, zone:game.zone, winners, cupWinner:game.cup?.winner||null, supercupWinner:game.supercup?.winner||null, supercup:game.supercup||null, awards, playerStats:structuredClone(game.playerStats||{competitions:{},total:{}}), transfers:(game.transferHistory||[]).filter(t=>Number(t.season)===Number(game.season)), regens:regens.map(r=>({player:r.name,position:r.position})), movements, finalTables:Object.fromEntries(leagues.map(l=>[l, sorted[l]||[]])), leagueResults:[...(game.results||[])], cupResults:[...(game.cupResults||[])]});
  game.season++; activeViewSeason=game.season; game.round=0; game.pendingSupercup={season:game.season, mainChampion:winners[leagues[0]], cupWinner:game.cup?.winner||null}; game.supercup=null; game.phase=game.pendingSupercup?.cupWinner ? 'supercup' : 'league'; game.divisions=nextDivisions; game.lastTransfers=performTransferWindow(game.divisions); Object.values(game.divisions||{}).flat().forEach(normalizeSquadStatuses); const built=buildSeason(game.divisions); game.tables=built.tables; game.schedules=built.schedules; game.results=[]; game.cupResults=[]; game.playerStats={competitions:{}, total:{}}; game.lastMovements=movements; game.cup=buildCup(); activeCompetition=game.config?.leagues?.[0] || activeCompetition; autosave(true); alert('Nova temporada iniciada.'); render();
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
  Object.keys(game.divisions||{}).forEach(l=>game.divisions[l]=game.divisions[l].map(sanitizeTeam)); Object.values(game.divisions||{}).flat().forEach(normalizeSquadStatuses);
  game.museum ||= {}; game.playerStats ||= {competitions:{}, total:{}}; game.awards ||= []; game.transferHistory ||= []; game.lastTransfers ||= []; if(!game.tables || !game.schedules){ const built=buildSeason(game.divisions); game.tables=built.tables; game.schedules=built.schedules; }
  game.cup ||= buildCup(); game.cupResults ||= []; game.results ||= []; game.history ||= []; game.pendingSupercup ||= null; if(game.pendingSupercup && !game.supercup) game.phase='supercup'; game.phase ||= 'league';
  activeCompetition=competitionOptions().includes(activeCompetition) ? activeCompetition : competitionOptions()[0]; activeViewSeason=game.season;
  document.getElementById('skip-round').onclick=skipCurrentWeek; document.getElementById('settings-btn').onclick=openSettings; document.getElementById('close-settings').onclick=closeSettings;
  document.getElementById('export-save').onclick=()=>downloadJSON(`${game.id}.json`, game);
  document.getElementById('import-save').onchange=async e=>{ if(!e.target.files[0])return; try{ const imported=await readJSONFile(e.target.files[0]); imported.slot=game.slot; imported.id='slot_'+game.slot; game=imported; game.config=normalizeConfig(game.config); activeCompetition=game.config?.leagues?.[0] || Object.keys(game.divisions||{})[0]; autosave(true); render(); closeSettings(); }catch(err){ alert('Save inválido: '+err.message); } };
  document.getElementById('autosave-frequency').onchange=e=>setSettings({autosaveFrequency:e.target.value});
  document.getElementById('simulation-speed').onchange=e=>setSettings({simulationSpeed:Number(e.target.value)});
  renderTabs(); render(); showPanel('panel-table');
}
window.addEventListener('DOMContentLoaded', init);
