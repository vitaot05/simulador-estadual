import {getSaves, deleteSave, readJSONFile, upsertSave} from './storage.js';
import {escapeHTML} from './utils.js';
function go(path){ location.href = path; }
function renderSaves(){
  const box=document.getElementById('saves');
  const saves=getSaves();
  if(!saves.length){ box.innerHTML='<p class="muted">Nenhum save encontrado. Você também pode importar um save em JSON.</p>'; return; }
  box.innerHTML=saves.map(s=>`<div class="save-card"><strong>${escapeHTML(s.name||'Save sem nome')}</strong><p class="muted">${escapeHTML(s.zone||s.config?.zone||'Liga')} • Temporada ${s.season||2026} • ${s.updatedAt?new Date(s.updatedAt).toLocaleString('pt-BR'):''}</p><div class="row"><button class="btn btn-gold" data-load="${escapeHTML(s.id)}">Carregar</button><button class="btn btn-red" data-del="${escapeHTML(s.id)}">Excluir</button></div></div>`).join('');
  box.querySelectorAll('[data-load]').forEach(b=>b.onclick=()=>go(`game.html?save=${encodeURIComponent(b.dataset.load)}`));
  box.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{ if(confirm('Excluir este save?')){ deleteSave(b.dataset.del); renderSaves(); } });
}
async function importSave(file){
  try{
    const data=await readJSONFile(file);
    if(!data.config || !data.divisions) throw new Error('Este arquivo parece ser uma configuração de liga, não um save de jogo. Use o editor para configurações.');
    if(!data.id)data.id='save_'+Date.now();
    upsertSave(data); renderSaves(); alert('Save importado.');
  }catch(err){ alert('Não foi possível importar: '+err.message); }
}
window.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('new-game').onclick=()=>go('game.html?new=1');
  document.getElementById('editor').onclick=()=>go('editor.html');
  document.getElementById('import-save').onchange=e=>e.target.files[0]&&importSave(e.target.files[0]);
  renderSaves();
});
