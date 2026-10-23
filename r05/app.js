import * as store from './store.js?v=0.5.2';

const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = n => n < 1024 ? n+' Б' : n < 1048576 ? (n/1024).toFixed(1)+' КиБ' : (n/1048576).toFixed(1)+' МиБ';
const date = value => new Date(value).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const stamp = () => new Date().toISOString().replace(/[:.]/g,'-');
let snapshot = null, busy = false, stale = false, uncertain = false, reloadSuggested = false, activeDocument = null, pendingAttachment = null, preparedBackup = null, preparedLegacy = null, previous = null;
let previousRequest=0, restoreOperation=null;

function restoreText(text,kind='') {
  $('restoreProgress').hidden=false;
  $('restoreProgress').textContent=text;
  $('restoreProgress').className='restore-progress'+(kind?' '+kind:'');
}
function updateRestoreDock() {
  if(!restoreOperation)return;
  const seconds=Math.floor((Date.now()-restoreOperation.started)/1000);
  const text=restoreOperation.text+(seconds?'\nПрошло '+seconds+' с.':'');
  restoreText(text);
  $('operationDock').textContent=text;
}
function startRestore(text) {
  if(restoreOperation)clearInterval(restoreOperation.timer);
  restoreOperation={text,started:Date.now()};
  restoreOperation.timer=setInterval(updateRestoreDock,1000);
  $('operationDock').hidden=false;
  notice(text);updateRestoreDock();
}
function restoreStage(progress) {
  if(!restoreOperation)return;
  const stages={catalogue:'Проверяем структуру и связи каталога…',base64:'Читаем содержимое вложений…',hash:'Проверяем размеры и SHA‑256 файлов…',write:'Проверки завершены. Сохраняем архив и предыдущий снимок…'};
  const stage=typeof progress==='string'?progress:progress?.stage;
  const count=typeof progress==='object'&&Number.isFinite(progress.total)&&progress.total>0?' ('+progress.completed+' из '+progress.total+')':'';
  restoreOperation.text=(stages[stage]||'Восстанавливаем архив…')+count;
  updateRestoreDock();
}
function finishRestore(success) {
  if(restoreOperation)clearInterval(restoreOperation.timer);
  restoreOperation=null;$('operationDock').hidden=true;
  restoreText($('message').textContent,success?'success':'error');
}
function readText(file) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{finish(Object.assign(new Error('Чтение файла заняло слишком много времени. Сохрани его полностью на iPhone и выбери заново.'),{code:'TIMEOUT'}));try{reader.abort();}catch(_){}},60000);
    reader.onload=()=>finish(null,reader.result);
    reader.onerror=()=>finish(reader.error||new Error('Не удалось прочитать файл.'));
    reader.onabort=()=>finish(new Error('Чтение файла отменено.'));
    try{reader.readAsText(file);}catch(error){finish(error);}
  });
}

function notice(text, kind='') {
  $('message').textContent=text;
  $('message').className='notice'+(kind?' '+kind:'');
}
function showTab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected',String(button.dataset.tab===name));
  for (const section of document.querySelectorAll('main > section')) section.hidden=section.id!==name;
}
function controls() {
  const disabled=busy||!snapshot||stale;
  for (const id of ['addProject','addRevision','importLegacy','importBackup','restorePrevious']) $(id).disabled=disabled;
  $('importLegacy').disabled=disabled||!!snapshot?.projects.length||!!snapshot?.documents.length||!!snapshot?.revisions.length;
  $('importLegacyFile').disabled=$('importLegacy').disabled||!preparedLegacy;
  $('legacyFile').disabled=$('importLegacy').disabled;
  $('importBackup').disabled=disabled||!preparedBackup;
  $('restorePrevious').disabled=disabled||!previous?.available;
  $('exportBackup').disabled=busy||!snapshot||stale;
  $('backupFile').disabled=busy||!snapshot||stale;
  $('reloadCatalog').disabled=busy;
  $('reloadRestore').disabled=busy;
  $('reloadRow').hidden=(!stale&&!reloadSuggested&&!!snapshot);
  $('restoreReloadRow').hidden=!stale&&!reloadSuggested;
  $('reloadHint').textContent=uncertain?'Результат записи ещё не подтверждён. Перечитай фактическое состояние перед новой операцией.':'Введённые поля останутся на экране.';
  for (const element of $('documentList').querySelectorAll('button,select')) element.disabled=disabled;
  $('docProject').disabled=busy||!!activeDocument;
  $('docName').disabled=busy||!!activeDocument;
  $('docFormat').disabled=busy||!!activeDocument;
  $('projectName').disabled=busy;
  $('docRevision').disabled=busy;
  $('attachmentFile').disabled=busy;
  $('cancelRevision').disabled=busy;
  document.body.setAttribute('aria-busy',String(busy));
}
function showError(error, prefix='Операция не выполнена') {
  if(error?.code==='STALE') stale=true;
  if(error?.code==='UNCERTAIN'){stale=true;uncertain=true;}
  let detail=error?.message||String(error);
  if(/blob.*(?:prepar|serializ)|(?:prepar|serializ).*blob/i.test(detail)) {reloadSuggested=true;detail='Safari не смог подготовить вложение к сохранению прежним способом. Проверь, что в шапке указана R05.2, закрой прежнюю вкладку и открой приложение заново. Затем повторно выбери тот же файл резервной копии. Не очищай данные Safari.';}
  else if(error?.name==='DataCloneError') {reloadSuggested=true;detail='Браузер не смог подготовить данные для локального сохранения. Проверь версию R05.2 в шапке и открой приложение заново. Файл резервной копии можно выбрать повторно; не очищай данные браузера.';}
  else if(error?.name==='QuotaExceededError') detail='На устройстве недостаточно доступного места. Данные операции не сохранены. Освободи место и попробуй ещё раз.';
  else if(error?.name==='SecurityError') detail='Браузер запретил доступ к локальному хранилищу. Проверь настройки Safari.';
  else if(error?.name==='UnknownError'||error?.name==='InvalidStateError') {reloadSuggested=true;detail='Браузер не смог выполнить операцию с локальным хранилищем. Закрой другие вкладки приложения и перечитай каталог перед повторной попыткой. Исходный файл резервной копии не изменялся. Не очищай данные браузера.';}
  if(uncertain)detail+=' Результат записи не подтверждён. Новые изменения заблокированы: нажми «Перечитать каталог», чтобы увидеть фактическое состояние.';
  notice(prefix+': '+detail,'error');
  if(stale||reloadSuggested)restoreText($('message').textContent,'error');
  controls();
}
async function refreshPrevious() {
  const request=++previousRequest;
  previous=null;$('previousInfo').textContent='Проверяем наличие предыдущего снимка…';controls();
  try {
    const result=await store.getPreviousInfo();
    if(request!==previousRequest)return;
    previous=result;
    $('previousInfo').textContent=previous.available ? `${previous.projects} проектов · ${previous.documents} документов · ${previous.revisions} редакций. Восстановление заменит текущий архив.` : 'Снимка пока нет. Он появится перед первым восстановлением или переносом R04.';
  } catch(error) {
    if(request!==previousRequest)return;
    previous=null;
    $('previousInfo').textContent='Снимок недоступен: '+error.message;
  }
  controls();
}
function fillProjects(id, all=false) {
  const selected=$(id).value;
  $(id).innerHTML=(all?'<option value="">Все проекты</option>':'')+snapshot.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if(snapshot.projects.some(p=>p.id===selected)||all&&selected==='') $(id).value=selected;
  else if(selected&&!all){const option=document.createElement('option');option.value='';option.textContent='Выбери проект заново';option.disabled=true;$(id).prepend(option);$(id).value='';}
}
function attachmentCount(){return snapshot.revisions.filter(r=>r.attachment).length;}
function attachmentSize(){return snapshot.revisions.reduce((sum,r)=>sum+(r.attachment?.size||0),0);}
function render() {
  if(!snapshot)return;
  $('projectCount').textContent=snapshot.projects.length;
  $('documentCount').textContent=snapshot.documents.length;
  $('projectSummary').textContent=snapshot.revisions.length+' редакций в архиве';
  $('projectList').innerHTML=snapshot.projects.length?snapshot.projects.map(p=>{
    const groups=snapshot.documents.filter(d=>d.projectId===p.id);
    const ids=new Set(groups.map(d=>d.id));
    return `<button class="project-card" data-project="${esc(p.id)}"><span class="project-title">${esc(p.name)}</span><span class="project-meta">Документов: ${groups.length} · Редакций: ${snapshot.revisions.filter(r=>ids.has(r.documentId)).length}</span><span class="open-project">Открыть документы →</span></button>`;
  }).join(''):'<div class="empty"><strong>Начни с первого проекта</strong><p>Собери документы и редакции одной конструкции в общем рабочем пространстве.</p></div>';
  fillProjects('docProject');fillProjects('projectFilter',true);
  if(activeDocument) {
    const group=snapshot.documents.find(d=>d.id===activeDocument);
    if(group) {$('docProject').value=group.projectId;$('docName').value=group.name;$('docFormat').value=group.format;}
    else {activeDocument=null;$('revisionFormLabel').textContent='Документ отсутствует в перечитанном каталоге';$('revisionFormTitle').textContent='Черновик редакции';$('cancelRevision').hidden=false;}
  }
  renderDocuments();
  $('backupStats').innerHTML=`<div><strong>${snapshot.projects.length}</strong><span>проектов</span></div><div><strong>${snapshot.revisions.length}</strong><span>редакций</span></div><div><strong>${attachmentCount()}</strong><span>файлов · ${bytes(attachmentSize())}</span></div>`;
  $('eventList').innerHTML=snapshot.events?.length?snapshot.events.map(event=>`<div class="revision"><div style="overflow-wrap:anywhere">${esc(event.text)}</div><div class="muted" style="font-size:11px;margin-top:4px">${esc(/^\d{4}-\d{2}-\d{2}T/.test(event.date)?date(event.date):event.date)}</div></div>`).join(''):'<div class="empty"><strong>Журнал пока пуст</strong><p>Здесь появятся события работы с архивом.</p></div>';
  controls();
}
function renderDocuments() {
  if(!snapshot)return;
  const project=$('projectFilter').value;
  const query=$('search').value.trim().toLocaleLowerCase('ru-RU');
  const groups=snapshot.documents.filter(d=>{
    if(project&&d.projectId!==project)return false;
    const name=snapshot.projects.find(p=>p.id===d.projectId)?.name||'';
    const revs=snapshot.revisions.filter(r=>r.documentId===d.id);
    return [d.name,d.format,name,...revs.flatMap(r=>[r.revision,r.status,r.attachment?.name||''])].join(' ').toLocaleLowerCase('ru-RU').includes(query);
  });
  $('documentList').innerHTML=groups.length?groups.map(group=>{
    const revisions=snapshot.revisions.filter(r=>r.documentId===group.id).map((r,i)=>({...r,order:i})).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.order-a.order);
    const latestUpload=revisions.find(r=>r.attachment);
    const pname=snapshot.projects.find(p=>p.id===group.projectId)?.name||'';
    return `<article class="doc-card"><div class="doc-title"><div class="title-line"><div><h3>${esc(group.name)}</h3><div class="muted">${esc(pname)} · ${revisions.length} редакций</div></div><span class="format">${esc(group.format)}</span></div></div>${revisions.map(r=>`<div class="revision"><div class="revision-top"><div><span class="revision-code">${esc(r.revision)}</span><div class="badges">${r.id===revisions[0]?.id?'<span class="badge">Последняя зарегистрированная</span>':''}${r.id===latestUpload?.id?'<span class="badge gold">Последняя с файлом</span>':''}${r.status==='Разрешено к выдаче'?'<span class="badge green">Выдача: отметка пользователя</span>':''}</div></div><label class="status-control-wrap"><span class="muted" style="font-size:10px">Статус пользователя</span><select class="status-control" aria-label="Статус ${esc(r.revision)}" data-action="status" data-id="${esc(r.id)}">${store.STATUSES.map(status=>`<option${r.status===status?' selected':''}${status==='Разрешено к выдаче'&&!r.attachment?' disabled':''}>${esc(status)}</option>`).join('')}</select></label></div><div class="muted" style="font-size:11px;margin-bottom:8px">Зарегистрировано ${esc(date(r.createdAt))}</div>${r.attachment?`<div class="file-name">${esc(r.attachment.name)}</div><div class="file-meta">${bytes(r.attachment.size)} · Файл закреплён за редакцией</div><details><summary class="file-meta">Контрольная сумма SHA‑256</summary><code class="hash">${esc(r.attachment.sha256)}</code></details><div class="actions"><button class="small ghost" data-action="download" data-id="${esc(r.id)}">Скачать файл</button></div>`:'<div class="muted">Файл ещё не прикреплён.</div><div class="actions"><button class="small ghost" data-action="attach" data-id="'+esc(r.id)+'">Прикрепить файл</button></div>'}</div>`).join('')}<div class="doc-bottom"><button class="small ghost" data-action="newRevision" data-id="${esc(group.id)}">+ Новая редакция</button></div></article>`;
  }).join(''):`<div class="empty"><strong>${snapshot.documents.length?'Ничего не найдено':'Документов пока нет'}</strong><p>${snapshot.documents.length?'Измени поиск или фильтр по проекту.':'Зарегистрируй первую редакцию и прикрепи к ней файл.'}</p></div>`;
  controls();
}
function resetRevisionForm() {
  activeDocument=null;
  $('docName').value='';$('docRevision').value='';
  $('revisionFormLabel').textContent='Регистрация документа';
  $('revisionFormTitle').textContent='Новая редакция';
  $('cancelRevision').hidden=true;
}
async function run(action, success, after) {
  if(busy||!snapshot||stale)return false;
  busy=true;controls();
  try {
    snapshot=await action(snapshot.version);
    reloadSuggested=false;
    if(after)after();
    preparedBackup=null;$('backupFile').value='';$('backupPreview').textContent='';
    preparedLegacy=null;$('legacyFile').value='';$('legacyPreview').textContent='';
    render();notice(success,'success');void refreshPrevious();return true;
  } catch(error) {showError(error);render();return false;}
  finally {busy=false;controls();}
}
function download(blob,name) {
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>showTab(button.dataset.tab));
$('addProject').addEventListener('click',()=>{
  const name=$('projectName').value.trim();
  if(!name)return notice('Укажи название проекта.','error');
  return run(expectedVersion=>store.addProject({name,expectedVersion}),'Проект сохранён.',()=>{$('projectName').value='';});
});
$('projectList').addEventListener('click',event=>{
  const button=event.target.closest('[data-project]');if(!button)return;
  $('projectFilter').value=button.dataset.project;
  if(!activeDocument)$('docProject').value=button.dataset.project;
  $('search').value='';renderDocuments();showTab('documents');
});
$('addRevision').addEventListener('click',()=>{
  const projectId=$('docProject').value,name=$('docName').value.trim(),format=$('docFormat').value,revision=$('docRevision').value.trim();
  if(!projectId||!name||!revision)return notice('Выбери проект и укажи название документа и редакцию.','error');
  return run(expectedVersion=>store.addRevision({projectId,name,format,revision,expectedVersion}),'Редакция сохранена. Теперь можно прикрепить файл.',()=>{$('docRevision').value='';});
});
$('cancelRevision').addEventListener('click',()=>{resetRevisionForm();controls();});
$('search').addEventListener('input',renderDocuments);
$('projectFilter').addEventListener('change',renderDocuments);
$('documentList').addEventListener('change',event=>{
  const select=event.target.closest('[data-action="status"]');if(!select)return;
  const revision=snapshot.revisions.find(r=>r.id===select.dataset.id);
  if(!revision)return;
  const status=select.value;
  if(status==='Разрешено к выдаче'&&!confirm('Отметить редакцию «'+revision.revision+'» как разрешённую к выдаче? Прежняя разрешённая редакция этого документа перейдёт в архив. Это твоя отметка в прототипе, а не автоматическое согласование или производственный допуск.')){select.value=revision.status;return;}
  return run(expectedVersion=>store.setStatus({revisionId:revision.id,status,expectedVersion}),'Статус пользователя сохранён.');
});
$('documentList').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-action]');if(!button||busy||stale)return;
  const id=button.dataset.id;
  if(button.dataset.action==='newRevision') {
    const group=snapshot.documents.find(d=>d.id===id);if(!group)return;
    if(($('docName').value.trim()||$('docRevision').value.trim())&&!confirm('Перейти к новой редакции выбранного документа? Введённые поля формы будут заменены.'))return;
    activeDocument=id;$('docProject').value=group.projectId;$('docName').value=group.name;$('docFormat').value=group.format;$('docRevision').value='';
    $('revisionFormLabel').textContent='Редакция существующего документа';$('revisionFormTitle').textContent=group.name;$('cancelRevision').hidden=false;controls();$('docRevision').focus();$('docRevision').scrollIntoView({block:'center',behavior:'smooth'});
  } else if(button.dataset.action==='attach') {
    pendingAttachment=id;$('attachmentFile').value='';$('attachmentFile').click();
  } else if(button.dataset.action==='download') {
    busy=true;controls();
    try {const attachment=await store.getAttachment(id);if(!attachment)throw Error('Файл не найден');download(attachment.blob,attachment.name);notice('Файл подготовлен для скачивания. Сохрани его в «Файлы».','success');}
    catch(error){showError(error,'Не удалось скачать файл');}
    finally{busy=false;controls();}
  }
});
$('attachmentFile').addEventListener('change',async event=>{
  const file=event.target.files[0],revisionId=pendingAttachment;pendingAttachment=null;
  if(!file||!revisionId)return;
  if(file.size>store.MAX_FILE_BYTES){event.target.value='';return notice('Файл больше '+bytes(store.MAX_FILE_BYTES)+'. Выбери файл меньшего размера.','error');}
  if(attachmentSize()+file.size>store.MAX_TOTAL_BYTES){event.target.value='';return notice('Вложений станет больше '+bytes(store.MAX_TOTAL_BYTES)+'. Файл не сохранён.','error');}
  const revision=snapshot.revisions.find(r=>r.id===revisionId);
  if(!revision||!confirm('Прикрепить «'+file.name+'» ('+bytes(file.size)+') к редакции '+revision.revision+'? Заменить этот файл в той же редакции будет нельзя.')){event.target.value='';return;}
  await run(expectedVersion=>store.attachFile({revisionId,file,expectedVersion}),'Файл сохранён. Контрольная сумма SHA‑256 рассчитана.');
  event.target.value='';
});
$('exportBackup').addEventListener('click',async()=>{
  if(busy||!snapshot||stale)return;busy=true;controls();notice('Проверяем вложения и готовим полную копию…');
  try {
    const backup=await store.exportBackup();
    download(new Blob([JSON.stringify(backup)],{type:'application/json'}),'IGNIS_PRO_R05_full_'+stamp()+'.json');
    notice('Полная копия подготовлена: '+backup.snapshot.projects.length+' проектов, '+backup.snapshot.revisions.length+' редакций, '+backup.manifest.length+' файлов. Размеры и SHA‑256 вложений проверены. Сохрани файл вне приложения.','success');
  } catch(error){showError(error,'Не удалось подготовить копию');}
  finally{busy=false;controls();}
});
$('backupFile').addEventListener('change',async event=>{
  const file=event.target.files[0];preparedBackup=null;$('backupPreview').textContent='';
  if(!file||busy){controls();return;}
  busy=true;controls();restoreText('Читаем выбранную резервную копию…');
  try {
    const maxBackup=store.MAX_BACKUP_BYTES||80*1024*1024;
    if(file.size>maxBackup)throw Error('Файл копии больше '+bytes(maxBackup));
    const text=await readText(file);
    const backup=JSON.parse(text);
    if(backup.app!=='RRR'||backup.kind!=='full'||backup.schemaVersion!==1||!Array.isArray(backup.snapshot?.projects)||!Array.isArray(backup.snapshot?.documents)||!Array.isArray(backup.snapshot?.revisions)||!Array.isArray(backup.manifest))throw Error('Это не полная резервная копия R05. Для каталога R04 используй отдельный перенос.');
    preparedBackup=backup;
    $('backupPreview').textContent='По описанию копии: '+backup.snapshot.projects.length+' проектов, '+backup.snapshot.documents.length+' документов, '+backup.snapshot.revisions.length+' редакций, '+backup.manifest.length+' файлов. Полная проверка структуры, связей, размеров и SHA‑256 будет выполнена перед записью.';
    restoreText('Файл прочитан. Готово к проверке и восстановлению.');
    notice('Копия выбрана. Проверь состав и нажми «Проверить и восстановить».');
  } catch(error){event.target.value='';showError(error,'Не удалось прочитать копию');restoreText($('message').textContent,'error');}
  finally{busy=false;controls();}
});
$('importBackup').addEventListener('click',async()=>{
  if(!preparedBackup||busy||stale)return;
  if(!confirm('Заменить текущий архив выбранной полной копией? Сначала сохрани внешний экспорт. Предыдущее состояние останется одним локальным снимком восстановления.'))return;
  const backup=preparedBackup;
  const success=await run(async expectedVersion=>{
    startRestore('Начинаем проверку структуры, размеров и SHA‑256 вложений…');
    await new Promise(resolve=>setTimeout(resolve,0));
    return store.importBackup({backup,expectedVersion,onProgress:restoreStage});
  },'Полная копия восстановлена. Структура, связи, размеры и SHA‑256 всех вложений проверены.',()=>resetRevisionForm());
  finishRestore(success);
});
$('restorePrevious').addEventListener('click',async()=>{
  if(!previous?.available||busy||stale)return;
  if(!confirm('Вернуть предыдущее состояние архива? Текущий каталог и вложения будут заменены. Текущее состояние станет новым снимком восстановления.'))return;
  const success=await run(async expectedVersion=>{
    startRestore('Проверяем предыдущий снимок и контрольные суммы вложений…');
    await new Promise(resolve=>setTimeout(resolve,0));
    return store.restorePrevious({expectedVersion,onProgress:restoreStage});
  },'Предыдущее состояние восстановлено, контрольные суммы вложений проверены.',()=>resetRevisionForm());
  finishRestore(success);
});
$('importLegacy').addEventListener('click',()=>{
  if(busy||stale)return;
  if(!confirm('Перенести проекты, карточки документов и журнал R04 в пустой R05? Прежний каталог R04 останется без изменений. Оригиналов файлов в нём нет.'))return;
  return run(expectedVersion=>store.importLegacy({expectedVersion}),'Каталог R04 перенесён. Прежние данные не изменены. Прикрепи оригиналы файлов к нужным редакциям.');
});
$('legacyFile').addEventListener('change',async event=>{
  const file=event.target.files[0];preparedLegacy=null;$('legacyPreview').textContent='';
  if(!file||busy){controls();return;}
  busy=true;controls();
  try {
    if(file.size>20*1024*1024)throw Error('Каталог R04 больше 20 МиБ.');
    const raw=await readText(file),root=JSON.parse(raw),catalog=root.catalog===undefined?root:root.catalog;
    if(!Array.isArray(catalog?.projects)||!Array.isArray(catalog?.docs)||!Array.isArray(catalog?.events))throw Error('В файле нет каталога R04: projects, docs, events.');
    preparedLegacy=raw;
    $('legacyPreview').textContent='По описанию файла: '+catalog.projects.length+' проектов, '+catalog.docs.length+' карточек документов, '+catalog.events.length+' событий. Полная проверка данных будет выполнена перед записью. Файлов-вложений в каталоге R04 нет.';
    notice('Экспорт R04 выбран. Нажми «Перенести из файла R04».');
  } catch(error){event.target.value='';showError(error,'Не удалось прочитать каталог R04');}
  finally{busy=false;controls();}
});
$('importLegacyFile').addEventListener('click',()=>{
  if(!preparedLegacy||busy||stale)return;
  if(!confirm('Перенести выбранный каталог R04 в пустой R05? Будут перенесены проекты, карточки документов и журнал. Исходный файл и прежний каталог не изменятся.'))return;
  const raw=preparedLegacy;
  return run(expectedVersion=>store.importLegacy({expectedVersion,raw}),'Каталог из файла R04 перенесён. Прикрепи оригиналы файлов к нужным редакциям.');
});
async function load(first=false) {
  if(busy)return;busy=true;controls();notice('Открываем локальный архив…');
  try {
    snapshot=await(first?store.init():store.readSnapshot());stale=false;uncertain=false;reloadSuggested=false;render();void refreshPrevious();document.body.dataset.ready='true';notice(first?'Архив открыт. Данные хранятся локально на этом устройстве.':'Каталог перечитан. Введённые поля сохранены.','success');
    if(!$('restoreProgress').hidden)restoreText('Каталог перечитан. На экране показано фактическое сохранённое состояние.','success');
  } catch(error){showError(error,'Не удалось открыть архив');$('reloadRow').hidden=false;}
  finally{busy=false;controls();}
}
$('reloadCatalog').addEventListener('click',()=>load(!snapshot));
$('reloadRestore').addEventListener('click',()=>load(!snapshot));
window.addEventListener('focus',async()=>{
  if(busy||!snapshot||stale)return;
  const checkedVersion=snapshot.version;
  try {
    const current=await store.readSnapshot();
    if(busy||!snapshot||snapshot.version!==checkedVersion)return;
    if(current.version!==checkedVersion){stale=true;notice('Архив изменён в другой вкладке. Перечитай каталог перед продолжением. Введённые поля сохранены.','error');restoreText($('message').textContent,'error');controls();}
  }
  catch(error){if(!busy&&snapshot?.version===checkedVersion)showError(error,'Не удалось проверить актуальность каталога');}
});
load(true);
