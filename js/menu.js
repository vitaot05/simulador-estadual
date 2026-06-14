import {getSaves, deleteSave, SLOT_COUNT} from './storage.js';
import {escapeHTML} from './utils.js';
function go(path){ location.href = path; }
function slotSave(slot){ return getSaves().find(s=>Number(s.slot)===Number(slot)); }
function renderSlots(){
  const box=document.getElementById('slots');
  box.innerHTML = Array.from({length:SLOT_COUNT},(_,i)=>i+1).map(slot=>{
    const s=slotSave(slot);
    if(!s) return `<div class="save-card slot-card"><div><strong>Slot ${slot}</strong><p class="muted">Vazio</p></div><button class="btn btn-gold" data-new="${slot}"><i class="fa-solid fa-play"></i>Novo jogo</button></div>`;
    return `<div class="save-card slot-card"><div><strong>Slot ${slot}</strong><p class="muted">${escapeHTML(s.zone||s.config?.zone||'Liga')} • Temporada ${s.season||2026} • ${s.updatedAt?new Date(s.updatedAt).toLocaleString('pt-BR'):''}</p></div><div class="row"><button class="btn btn-gold" data-load="${slot}"><i class="fa-solid fa-folder-open"></i>Carregar</button><button class="btn" data-new="${slot}"><i class="fa-solid fa-rotate"></i>Novo</button><button class="btn btn-red" data-del="${slot}"><i class="fa-solid fa-trash"></i>Excluir</button></div></div>`;
  }).join('');
  box.querySelectorAll('[data-new]').forEach(b=>b.onclick=()=>{ const slot=b.dataset.new; if(slotSave(slot) && !confirm('Sobrescrever o save deste slot?')) return; go(`game.html?new=1&slot=${slot}`); });
  box.querySelectorAll('[data-load]').forEach(b=>b.onclick=()=>go(`game.html?save=1&slot=${b.dataset.load}`));
  box.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{ if(confirm('Excluir este slot?')){ deleteSave(b.dataset.del); renderSlots(); } });
}
window.addEventListener('DOMContentLoaded',()=>{ document.getElementById('editor').onclick=()=>go('editor.html'); renderSlots(); });
