(function(){
'use strict';
const KEY='rrr-r04-catalog', RECOVERY=KEY+'-previous', LOCK=KEY+'-write';
const $=id=>document.getElementById(id), empty=()=>({projects:[],docs:[],events:[]});
const formats=['PDF','STEP','DWG','DXF','SLDPRT','XLSX','Другое'],statuses=['Не проверено','На проверке','Архив'];
const MAX_BYTES=20*1024*1024, MAX_RECORDS=50000;
let data=empty(),baseline=null,blocked=false,busy=false,damaged=null,recoveryMode=false;
function notice(s){$('message').textContent=s}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function object(x,label){if(!x||typeof x!=='object'||Array.isArray(x))throw Error(label+': ожидается объект')}
function str(x,label,max=1000){if(typeof x!=='string'||!x.trim()||x.length>max)throw Error(label+': неверная строка');return x}
function norm(s){return s.trim().toLocaleLowerCase('ru-RU')}
function validate(value){
 object(value,'Каталог');
 if(value.schemaVersion!==undefined&&value.schemaVersion!==1)throw Error('Неподдерживаемая версия каталога');
 if(value.app!==undefined&&value.app!=='RRR')throw Error('Файл другого приложения');
 let x=value.catalog===undefined?value:value.catalog;object(x,'Каталог');
 if(x.schemaVersion!==undefined&&x.schemaVersion!==1)throw Error('Неподдерживаемая версия данных');
 for(const k of ['projects','docs','events'])if(!Array.isArray(x[k])||x[k].length>MAX_RECORDS)throw Error(k+': неверный список или превышен лимит '+MAX_RECORDS);
 const ids=new Set(),names=new Set(),docs=new Set(),docIds=new Set();
 const projects=x.projects.map((p,i)=>{let label='Проект '+(i+1);object(p,label);let id=str(p.id,label+' ID',200),name=str(p.name,label+' название');if(ids.has(id)||names.has(norm(name)))throw Error(label+': повтор ID или названия');ids.add(id);names.add(norm(name));return {id,name}});
 const documents=x.docs.map((d,i)=>{let label='Документ '+(i+1);object(d,label);let id=str(d.id,label+' ID',200),project=str(d.project,label+' проект',200),name=str(d.name,label+' название'),revision=str(d.revision,label+' редакция',200);if(docIds.has(id))throw Error(label+': повтор ID');if(!ids.has(project))throw Error(label+': проект отсутствует');if(!formats.includes(d.format)||!statuses.includes(d.status))throw Error(label+': неверный формат или статус');let signature=JSON.stringify([project,norm(name),norm(revision)]);if(docs.has(signature))throw Error(label+': повтор редакции');docs.add(signature);docIds.add(id);return {id,project,name,revision,format:d.format,status:d.status}});
 const events=x.events.map((e,i)=>{object(e,'Событие '+(i+1));return {date:str(e.date,'Дата события',200),text:str(e.text,'Текст события',5000)}});
 return {projects,docs:documents,events};
}
function decode(raw){if(typeof raw!=='string'||raw.length>MAX_BYTES)throw Error('Каталог превышает допустимый размер');return validate(JSON.parse(raw))}
function warning(s){$('storageWarning').textContent=s;$('storageWarning').classList.toggle('hidden',!s)}
function updateControls(){for(const id of ['addProject','addDoc'])$(id).disabled=busy||blocked;$('import').disabled=busy||(blocked&&!recoveryMode);$('restorePrevious').disabled=busy||(blocked&&!recoveryMode);$('reloadCatalog').classList.toggle('hidden',!blocked);$('reloadCatalog').disabled=busy;$('downloadDamaged').classList.toggle('hidden',damaged===null);$('export').disabled=busy||damaged!==null}
function stale(){blocked=true;recoveryMode=false;warning('Каталог изменён в другой вкладке. Перечитай его перед продолжением. Введённые поля сохранены.');updateControls()}
function load(){try{const raw=localStorage.getItem(KEY);baseline=raw;const parsed=raw===null?empty():decode(raw);data=parsed;baseline=raw;blocked=false;damaged=null;recoveryMode=false;warning(navigator.locks?'':'Для безопасной работы в этом браузере используй одну вкладку приложения.');render();notice('Каталог загружен.')}catch(e){blocked=true;recoveryMode=false;try{damaged=localStorage.getItem(KEY);baseline=damaged;recoveryMode=damaged!==null}catch(_){}warning('Каталог не открыт: '+e.message+'. Запись заблокирована. Скачай исходник или восстанови предыдущую копию.')}updateControls()}
function pname(id){let p=data.projects.find(x=>x.id===id);return p?p.name:'Неизвестный проект'}
function render(){const selected=$('docProject').value;
 $('projectList').innerHTML=data.projects.length?data.projects.map(p=>'<div class="item line"><div><strong>'+esc(p.name)+'</strong><div class="muted">'+data.docs.filter(d=>d.project===p.id).length+' документов</div></div><span class="tag">Проект</span></div>').join(''):'<p class="muted">Пока нет проектов.</p>';
 $('docProject').innerHTML=data.projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');if(data.projects.some(p=>p.id===selected))$('docProject').value=selected;
 let q=$('search').value.toLocaleLowerCase('ru-RU');let found=data.docs.filter(d=>(d.name+' '+d.revision+' '+d.format+' '+pname(d.project)).toLocaleLowerCase('ru-RU').includes(q));
 $('docList').innerHTML=found.length?found.map(d=>'<div class="item"><div class="line"><strong>'+esc(d.name)+'</strong><span class="tag">'+esc(d.format)+'</span></div><div class="muted">'+esc(pname(d.project))+' · '+esc(d.revision)+'</div><div class="actions" style="margin-top:9px"><span class="tag">'+esc(d.status)+'</span><button data-action="review" data-id="'+esc(d.id)+'">На проверку</button><button data-action="archive" data-id="'+esc(d.id)+'">В архив</button></div></div>').join(''):'<p class="muted">Документы не найдены.</p>';
 $('eventList').innerHTML=data.events.length?data.events.map(e=>'<div class="item"><div>'+esc(e.text)+'</div><div class="muted">'+esc(e.date)+'</div></div>').join(''):'<p class="muted">Журнал пуст.</p>';
}
function uid(prefix,candidate){for(let attempt=0;attempt<8;attempt++){let token;if(typeof crypto.randomUUID==='function')token=crypto.randomUUID();else{const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;token=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')}const id=prefix+token;if(!candidate.projects.some(x=>x.id===id)&&!candidate.docs.some(x=>x.id===id))return id}throw Error('Не удалось создать уникальный ID; повтори операцию')}
function log(candidate,text){candidate.events.unshift({date:new Date().toLocaleString('ru-RU'),text})}
async function locked(fn){if(navigator.locks)return navigator.locks.request(LOCK,fn);return fn()}
async function commit(candidate,{recover=false,allowBlocked=false}={}){
 if(blocked&&!allowBlocked)throw Error('Сначала перечитай каталог');candidate=validate(candidate);const serialized=JSON.stringify(candidate);if(serialized.length>MAX_BYTES)throw Error('Каталог превышает допустимый размер');
 await locked(()=>{const current=localStorage.getItem(KEY);if(current!==baseline){stale();throw Error('Каталог изменён в другой вкладке')}
 if(recover&&current!==null)localStorage.setItem(RECOVERY,current);
 localStorage.setItem(KEY,serialized);baseline=serialized;data=candidate;blocked=false;damaged=null;recoveryMode=false;
 });render();updateControls();
}
async function mutate(build,success,clear){if(busy||blocked)return;busy=true;updateControls();try{const candidate=validate(data);build(candidate);await commit(candidate);if(clear)clear();notice(success)}catch(e){notice('Изменения не сохранены: '+e.message)}finally{busy=false;updateControls()}}
for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>{for(const s of document.querySelectorAll('main section'))s.classList.toggle('hidden',s.id!==b.dataset.tab);for(const x of document.querySelectorAll('[data-tab]'))x.classList.toggle('primary',x===b);render()});
$('addProject').onclick=()=>{const name=$('projectName').value.trim();if(!name)return notice('Укажи название проекта.');return mutate(c=>{c.projects.push({id:uid('p',c),name});log(c,'Создан проект: '+name)},'Проект создан.',()=>{$('projectName').value=''})};
$('addDoc').onclick=()=>{const name=$('docName').value.trim(),project=$('docProject').value,revision=$('docRevision').value.trim(),format=$('docFormat').value;if(!name||!project||!revision)return notice('Выбери проект, название и редакцию.');return mutate(c=>{c.docs.push({id:uid('d',c),project,name,revision,format,status:'Не проверено'});log(c,'Проект «'+c.projects.find(p=>p.id===project)?.name+'»: зарегистрирован документ '+name+' / '+revision)},'Документ зарегистрирован.',()=>{$('docName').value='';$('docRevision').value=''})};
$('search').oninput=render;
$('docList').onclick=e=>{const b=e.target.closest('button[data-action]');if(!b||busy||blocked)return;return mutate(c=>{const d=c.docs.find(x=>x.id===b.dataset.id);if(!d)throw Error('Документ отсутствует');d.status=b.dataset.action==='archive'?'Архив':'На проверке';log(c,'Проект «'+c.projects.find(p=>p.id===d.project)?.name+'»: изменён статус '+d.name+' / '+d.revision+' → '+d.status)},'Статус сохранён.')};
function download(text,name){const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000)}
function stamp(){return new Date().toISOString().replace(/[:.]/g,'-')}
$('export').onclick=()=>{try{const catalog=validate(data);download(JSON.stringify({app:'RRR',schemaVersion:1,exportedAt:new Date().toISOString(),catalog},null,2),'RRR_R04.1_backup_'+stamp()+'.json');notice('Экспорт подготовлен. Сохрани файл в «Файлы».')}catch(e){notice('Ошибка экспорта: '+e.message)}};
$('downloadDamaged').onclick=()=>{if(damaged!==null)download(damaged,'RRR_damaged_'+stamp()+'.json')};
async function importCatalog(candidate,previous=false){const validated=validate(candidate);if(!confirm((previous?'Восстановить предыдущий каталог?':'Заменить текущий каталог?')+' Проектов: '+validated.projects.length+', документов: '+validated.docs.length+'. Предыдущий каталог будет сохранён для восстановления.'))return;await commit(validated,{recover:true,allowBlocked:previous||recoveryMode});warning(navigator.locks?'':'Для безопасной работы в этом браузере используй одну вкладку приложения.');notice('Каталог восстановлен.')}
$('import').onchange=async e=>{const f=e.target.files[0];if(!f||busy||(blocked&&!recoveryMode)){e.target.value='';return}busy=true;updateControls();try{if(f.size>MAX_BYTES)throw Error('Файл больше 20 МиБ');const text=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Не удалось прочитать файл'));r.onabort=()=>reject(Error('Чтение отменено'));r.readAsText(f)});await importCatalog(decode(text))}catch(err){notice('Ошибка импорта: '+err.message)}finally{busy=false;e.target.value='';updateControls()}};
$('restorePrevious').onclick=async()=>{if(busy||(blocked&&!recoveryMode))return;busy=true;updateControls();try{const raw=localStorage.getItem(RECOVERY);if(raw===null)throw Error('Предыдущая копия отсутствует');await importCatalog(decode(raw),true)}catch(e){notice('Восстановление не выполнено: '+e.message)}finally{busy=false;updateControls()}};
$('reloadCatalog').onclick=()=>{if(!busy)load()};
window.addEventListener('storage',e=>{if((e.key===KEY||e.key===null)&&e.newValue!==baseline)stale()});
load();
})();
