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
export function normalizeConfig(input){
  const cfg=structuredClone(input||{});
  cfg.id = slugify(cfg.id || cfg.zone || 'custom_league');
  cfg.zone = String(cfg.zone || 'Liga Personalizada');
  cfg.leagues = Array.isArray(cfg.leagues) ? cfg.leagues.map(String).filter(Boolean) : ['Série A'];
  cfg.teams = Array.isArray(cfg.teams) ? cfg.teams.map((t,i)=>({
    id: slugify(t.id || t.name || `team_${i+1}`),
    name: String(t.name || t.id || `Time ${i+1}`),
    city: t.city || '',
    state: t.state || '',
    rating: Math.max(1, Math.min(99, Number(t.rating)||70))
  })) : [];
  return cfg;
}
export function validateConfig(cfg){
  const errors=[];
  if(!cfg.id) errors.push('Falta id.');
  if(!cfg.zone) errors.push('Falta zone.');
  if(!cfg.leagues?.length) errors.push('Inclua pelo menos uma liga em leagues.');
  if((cfg.teams||[]).length < 2) errors.push('Inclua pelo menos 2 times.');
  const ids=new Set();
  for(const t of (cfg.teams||[])){
    if(!t.id || !t.name) errors.push('Todos os times precisam de id e name.');
    if(ids.has(t.id)) errors.push(`ID de time duplicado: ${t.id}`);
    ids.add(t.id);
  }
  return errors;
}
export function splitTeams(config, shouldShuffle=false){
  const cfg=normalizeConfig(config);
  const leagues=cfg.leagues;
  let teams=shouldShuffle ? shuffle(cfg.teams) : [...cfg.teams];
  if(teams.length % 2 === 1) teams = teams.slice(0, -1); // sempre quantidade par em competição jogável
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
export function makeSchedule(teamIds){
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
  return String(s ?? '').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
