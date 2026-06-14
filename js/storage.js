const SAVE_KEY = 'avanci_football_saves_v3';
const SETTINGS_KEY = 'avanci_football_settings_v1';
export const SLOT_COUNT = 3;
export function getSaves(){
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); }
  catch { return []; }
}
export function setSaves(saves){ localStorage.setItem(SAVE_KEY, JSON.stringify(saves.slice(0,SLOT_COUNT))); }
export function getSlot(slot){ return getSaves().find(s=>Number(s.slot)===Number(slot)) || null; }
export function upsertSave(save){
  const saves=getSaves().filter(s=>Number(s.slot)!==Number(save.slot));
  save.updatedAt = new Date().toISOString();
  saves.push(structuredClone(save));
  saves.sort((a,b)=>Number(a.slot)-Number(b.slot));
  setSaves(saves);
}
export function deleteSave(idOrSlot){ setSaves(getSaves().filter(s=>s.id!==idOrSlot && Number(s.slot)!==Number(idOrSlot))); }
export function getSettings(){
  try { return {...{autosaveFrequency:'1'}, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}')}; }
  catch { return {autosaveFrequency:'1'}; }
}
export function setSettings(settings){ localStorage.setItem(SETTINGS_KEY, JSON.stringify({...getSettings(), ...settings})); }
export function shouldAutosave(game){
  const freq = getSettings().autosaveFrequency || '1';
  if(freq === 'season') return game.round === 0;
  return Number(game.round || 0) % Number(freq || 1) === 0;
}
export function downloadJSON(filename, data){
  const blob=new Blob([JSON.stringify(data,null,2)], {type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 250);
}
export function readJSONFile(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{ try{ resolve(JSON.parse(reader.result)); } catch(err){ reject(err); } };
    reader.onerror=()=>reject(reader.error);
    reader.readAsText(file);
  });
}
