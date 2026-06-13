const SAVE_KEY = 'avanci_football_saves_v2';
export function getSaves(){
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); }
  catch { return []; }
}
export function setSaves(saves){ localStorage.setItem(SAVE_KEY, JSON.stringify(saves)); }
export function upsertSave(save){
  const saves=getSaves();
  const i=saves.findIndex(s=>s.id===save.id);
  save.updatedAt = new Date().toISOString();
  if(i>=0) saves[i]=structuredClone(save); else saves.unshift(structuredClone(save));
  setSaves(saves);
}
export function deleteSave(id){ setSaves(getSaves().filter(s=>s.id!==id)); }
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
