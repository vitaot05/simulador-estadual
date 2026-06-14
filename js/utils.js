export function slugify(value){
  return String(value||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
}
export function shuffle(list){
  const arr=[...list];
  for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}
export async function loadDefaultConfig(){
  const candidates=['../data/default_teams.json','./data/default_teams.json','data/default_teams.json'];
  let lastError=null;
  for(const path of candidates){
    try{
      const response=await fetch(path,{cache:'no-store'});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      return normalizeConfig(await response.json());
    }catch(err){ lastError=err; }
  }
  throw new Error('Não foi possível carregar data/default_teams.json. Abra o projeto por um servidor local, por exemplo: python -m http.server 8000. Detalhe: '+(lastError?.message||lastError));
}
export function reputationLabel(rep){
  return ['','Municipal','Estadual','Regional','Nacional','Continental','Intercontinental','Mundial'][Number(rep)] || 'Municipal';
}
export function generateRatingFromReputation(rep){
  const ranges={1:[38,49],2:[48,59],3:[58,69],4:[68,79],5:[78,87],6:[86,94],7:[93,99]};
  const [min,max]=ranges[Math.max(1,Math.min(7,Number(rep)||1))];
  return Math.floor(min + Math.random()*(max-min+1));
}
export function normalizeConfig(input){
  const cfg=structuredClone(input||{});
  cfg.id = slugify(cfg.id || cfg.zone || 'custom_league');
  cfg.zone = String(cfg.zone || 'Liga Personalizada');
  cfg.cup = String(cfg.cup || 'Copa Nacional');
  cfg.supercup = String(cfg.supercup || 'Supercopa Nacional');
  cfg.leagues = Array.isArray(cfg.leagues) ? cfg.leagues.map(String).filter(Boolean) : ['Série A'];
  cfg.teams = Array.isArray(cfg.teams) ? cfg.teams.map((t,i)=>({
    id: slugify(t.id || t.name || `team_${i+1}`),
    name: String(t.name || t.id || `Time ${i+1}`),
    reputation: Math.max(1, Math.min(7, Number(t.reputation ?? 1))),
    players: Array.isArray(t.players) ? t.players.map((p,j)=>({
      name: String(p.name || `Player ${j+1}`),
      nationality: String(p.nationality || 'br').toLowerCase(),
      age: Math.max(15, Math.min(50, Number(p.age || 25))),
      position: String(p.position || (j===0 ? 'GOL' : 'ATA')).toUpperCase(),
      status: String(p.status || (j<11 ? 'starter' : 'substitute')),
      reputation: String(p.reputation || 'normal'),
      rating: p.rating ? Number(p.rating) : undefined
    })) : []
  })) : [];
  return cfg;
}
export function validateConfig(cfg){
  const errors=[];
  if(!cfg.id) errors.push('Falta id.');
  if(!cfg.zone) errors.push('Falta zone.');
  if(!cfg.leagues?.length) errors.push('Inclua pelo menos uma liga em leagues.');
  if(!cfg.cup) errors.push('Falta cup.');
  if(!cfg.supercup) errors.push('Falta supercup.');
  if((cfg.teams||[]).length < 2) errors.push('Inclua pelo menos 2 times.');
  const ids=new Set();
  for(const t of (cfg.teams||[])){
    if(!t.id || !t.name) errors.push('Todos os times precisam de id e name.');
    if(ids.has(t.id)) errors.push(`ID de time duplicado: ${t.id}`);
    if(Number(t.reputation)<1 || Number(t.reputation)>7) errors.push(`Reputação inválida em ${t.name}: use 1 a 7.`);
    const starters=(t.players||[]).filter(p=>p.status==='starter');
    const keepers=starters.filter(p=>String(p.position).toUpperCase()==='GOL');
    if((t.players||[]).length && starters.length !== 11) errors.push(`${t.name} precisa ter exatamente 11 titulares.`);
    if((t.players||[]).length && keepers.length !== 1) errors.push(`${t.name} precisa ter exatamente 1 goleiro titular.`);
    const validPos=['GOL','ZAG','LAT','VOL','MEC','MEI','PNT','ATA'];
    for(const p of (t.players||[])){ if(!validPos.includes(String(p.position).toUpperCase())) errors.push(`${t.name}: posição inválida em ${p.name}.`); }
    ids.add(t.id);
  }
  return [...new Set(errors)];
}
export function splitTeams(config, shouldShuffle=false){
  const cfg=normalizeConfig(config);
  const leagues=cfg.leagues;
  let teams=shouldShuffle ? shuffle(cfg.teams) : [...cfg.teams];
  if(teams.length % 2 === 1) teams = teams.slice(0, -1);
  const leagueCount = leagues.length;
  let perLeague = Math.floor(teams.length / leagueCount);
  if(perLeague % 2 === 1) perLeague--;
  perLeague = Math.max(2, perLeague);
  const divisions={}; let idx=0;
  leagues.forEach((league, index)=>{
    const remaining = teams.length - idx;
    const leaguesLeft = leagueCount - index;
    let take = index === leagueCount-1 ? remaining : Math.min(perLeague, remaining - Math.max(0,(leaguesLeft-1)*2));
    if(take % 2 === 1) take--;
    if(take < 0) take = 0;
    divisions[league] = teams.slice(idx, idx + take);
    idx += take;
  });
  return divisions;
}
function singleRoundSchedule(teamIds){
  const ids=[...teamIds];
  if(ids.length < 2) return [];
  const teams = ids.length % 2 ? [...ids, '__bye__'] : ids;
  const n=teams.length;
  let list=[...teams];
  const rounds=[];
  for(let r=0; r<n-1; r++){
    const matches=[];
    for(let i=0; i<n/2; i++){
      const home=list[i], away=list[n-1-i];
      if(home !== '__bye__' && away !== '__bye__') matches.push(r%2 ? [away,home] : [home,away]);
    }
    rounds.push(matches);
    list=[list[0], list[n-1], ...list.slice(1,n-1)];
  }
  return rounds;
}
export function makeSchedule(teamIds){
  const first = singleRoundSchedule(teamIds);
  const second = first.map(round => round.map(([home,away]) => [away,home]));
  return [...first, ...second];
}
export function newTable(teams){
  const table={};
  teams.forEach(t=>table[t.id]={...t, points:0, played:0, won:0, drawn:0, lost:0, goalsFor:0, goalsAgainst:0, goalDifference:0});
  return table;
}
export function sortTable(table){
  return Object.values(table).sort((a,b)=>
    b.points-a.points || b.won-a.won || b.goalDifference-a.goalDifference || b.goalsFor-a.goalsFor || a.name.localeCompare(b.name)
  );
}
export function escapeHTML(s){
  return String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
