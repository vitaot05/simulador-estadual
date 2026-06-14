import {downloadJSON, readJSONFile} from './storage.js';
import {slugify, normalizeConfig, validateConfig, splitTeams, escapeHTML, loadDefaultConfig, reputationLabel} from './utils.js';
let data=null;
function syncFromForm(){
  data.id=slugify(document.getElementById('id').value);
  data.zone=document.getElementById('zone').value.trim();
  data.leagues=document.getElementById('leagues').value.split('\n').map(x=>x.trim()).filter(Boolean);
  data.teams=[...document.querySelectorAll('.team-line')].map(row=>({
    id:slugify(row.querySelector('.t-name').value),
    name:row.querySelector('.t-name').value.trim(),
    city:row.querySelector('.t-city').value.trim(),
    state:row.querySelector('.t-state').value.trim(),
    reputation:Number(row.querySelector('.t-reputation').value)||1
  })).filter(t=>t.name);
  updateTextAndValidation();
}
function updateTextAndValidation(){
  const cfg=normalizeConfig(data);
  document.getElementById('json').value=JSON.stringify(cfg,null,2);
  const errors=validateConfig(cfg);
  const divs=splitTeams(cfg,false);
  const preview=Object.entries(divs).map(([l,t])=>`${escapeHTML(l)}: ${t.length} times`).join(' • ');
  document.getElementById('validation').innerHTML = errors.length
    ? `<span class="bad">${errors.map(escapeHTML).join('<br>')}</span>`
    : `<span class="good">JSON válido.</span><br><span class="muted">Divisão matemática: ${preview}</span>`;
}
function render(){
  data=normalizeConfig(data);
  document.getElementById('id').value=data.id||'';
  document.getElementById('zone').value=data.zone||'';
  document.getElementById('leagues').value=(data.leagues||[]).join('\n');
  document.getElementById('teams').innerHTML=(data.teams||[]).map(t=>teamLine(t)).join('');
  bindLines(); updateTextAndValidation();
}
function teamLine(t={name:'',city:'',state:'',reputation:1}){ return `<div class="team-line"><input class="input t-name" value="${escapeHTML(t.name||'')}" placeholder="Nome"><input class="input t-city" value="${escapeHTML(t.city||'')}" placeholder="Cidade"><input class="input t-state" value="${escapeHTML(t.state||'')}" placeholder="UF"><select class="input t-reputation">${[1,2,3,4,5,6,7].map(n=>`<option value="${n}" ${Number(t.reputation)===n?'selected':''}>${n} - ${reputationLabel(n)}</option>`).join('')}</select><button class="btn btn-red rm" type="button"><i class="fa-solid fa-trash"></i></button></div>`; }
function bindLines(){
  document.querySelectorAll('.rm').forEach(b=>b.onclick=()=>{b.closest('.team-line').remove();syncFromForm();});
  document.querySelectorAll('.t-name,.t-city,.t-state,.t-reputation').forEach(i=>i.oninput=syncFromForm);
}
window.addEventListener('DOMContentLoaded',async()=>{
  try{ data=await loadDefaultConfig(); }catch(err){ alert(err.message); data=normalizeConfig({id:'campeonato_brasileiro',zone:'Campeonato Brasileiro de Futebol',leagues:['Série A'],teams:[]}); }
  render();
  ['id','zone','leagues'].forEach(id=>document.getElementById(id).oninput=syncFromForm);
  document.getElementById('add-team').onclick=()=>{document.getElementById('teams').insertAdjacentHTML('beforeend',teamLine());bindLines();syncFromForm();};
  document.getElementById('apply-json').onclick=()=>{try{data=normalizeConfig(JSON.parse(document.getElementById('json').value));render();}catch(e){alert('JSON inválido: '+e.message)}};
  document.getElementById('download').onclick=()=>{syncFromForm();downloadJSON(`${data.id||'league'}.json`,normalizeConfig(data));};
  document.getElementById('save-config').onclick=()=>{syncFromForm(); sessionStorage.setItem('avanci_pending_config', JSON.stringify(normalizeConfig(data))); location.href='game.html?new=1&fromEditor=1';};
  document.getElementById('import').onchange=async e=>{ if(e.target.files[0]){try{data=normalizeConfig(await readJSONFile(e.target.files[0]));render();}catch(err){alert('Não foi possível importar: '+err.message)}}};
});
