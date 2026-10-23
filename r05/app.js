import * as store from './store.js?v=0.8.0';
import { buildFilePlan } from './batch.js?v=0.8.0';
import { createMultipart } from './multipart.js?v=0.8.0';
const multipart=createMultipart(store);

const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = n => n < 1024 ? n+' Б' : n < 1048576 ? (n/1024).toFixed(1)+' КиБ' : n < 1073741824 ? (n/1048576).toFixed(1)+' МиБ' : (n/1073741824).toFixed(2)+' ГиБ';
const date = value => new Date(value).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const stamp = () => new Date().toISOString().replace(/[:.]/g,'-');
let snapshot = null, busy = false, stale = false, uncertain = false, reloadSuggested = false, activeDocument = null, pendingAttachment = null, preparedBackup = null, preparedLegacy = null, previous = null;
let previousRequest=0, restoreOperation=null;
let renameTarget=null, renameFocus=null, preparedCatalog=null;
const PAGE_SIZE=40;
let documentPage=1, index={projectNames:new Map(),documentsByProject:new Map(),revisionsByDocument:new Map()};
let batchRows=[],batchRunning=false,batchController=null,batchCancelRequested=false,batchTargetRow=null,batchTargetPage=1,storageInfoRequest=0;
let multipartPlan=null,multipartManifestRequested=false,multipartPartRequests=new Set(),multipartPage=0,multipartSelectedFiles=[],multipartSelection=null,multipartRunning=false,multipartController=null,multipartCancelRequested=false;
const extensionMap={PDF:['pdf'],STEP:['step','stp'],DWG:['dwg'],DXF:['dxf'],SLDPRT:['sldprt'],XLSX:['xlsx']};

function restoreText(text,kind='') {
  $('restoreProgress').hidden=false;
  $('restoreProgress').textContent=text;
  $('restoreProgress').className='restore-progress'+(kind?' '+kind:'');
}
function updateRestoreDock() {
  if(!restoreOperation)return;
  const seconds=Math.floor((Date.now()-restoreOperation.started)/1000);
  const text=restoreOperation.text+(seconds?'\nПрошло '+seconds+' с.':'');
  if(restoreOperation.kind==='batch')batchText(text);else if(restoreOperation.kind==='multipart')multipartText(text);else if(restoreOperation.kind==='migration'){$('migrationProgress').hidden=false;$('migrationProgress').textContent=text;}else restoreText(text);
  $('operationDock').textContent=text;
}
function startRestore(text,kind='restore') {
  if(restoreOperation)clearInterval(restoreOperation.timer);
  restoreOperation={text,started:Date.now(),kind};
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
  const kind=restoreOperation?.kind;
  if(restoreOperation)clearInterval(restoreOperation.timer);
  restoreOperation=null;$('operationDock').hidden=true;
  if(kind==='batch')batchText($('message').textContent,success?'success':'error');else if(kind==='multipart')multipartText($('message').textContent,success?'success':'error');else if(kind==='migration'){$('migrationProgress').hidden=false;$('migrationProgress').textContent=$('message').textContent;$('migrationProgress').className='restore-progress '+(success?'success':'error');}else restoreText($('message').textContent,success?'success':'error');
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
  $('catalogFile').disabled=disabled;
  $('mergeCatalog').disabled=disabled||!preparedCatalog;
  $('renameName').disabled=busy;
  $('saveRename').disabled=disabled;
  $('cancelRename').disabled=busy;
  for(const button of $('projectList').querySelectorAll('button'))button.disabled=disabled;
  $('showMoreDocuments').disabled=busy;
  $('batchFiles').disabled=disabled;
  $('clearBatch').disabled=busy||!batchRows.length;
  $('runBatch').disabled=disabled||!batchValidity().ready;
  $('cancelBatch').hidden=!batchRunning;
  $('cancelBatch').disabled=!batchRunning||batchCancelRequested;
  $('cancelBatch').textContent=batchCancelRequested?'Останавливаем…':'Отменить пакет';
  for(const button of $('batchPreview').querySelectorAll('button'))button.disabled=disabled;
  for(const button of $('batchTargetList').querySelectorAll('button'))button.disabled=disabled||button.dataset.unavailable==='true';
  $('prepareMultipart').disabled=disabled;
  $('downloadMultipartManifest').disabled=disabled||!multipartPlan;
  $('releaseMultipartExport').disabled=busy||!multipartPlan;
  $('multipartFiles').disabled=disabled;
  $('inspectMultipart').disabled=disabled||!multipartSelectedFiles.length;
  $('restoreMultipart').disabled=disabled||!multipartSelection;
  for(const button of $('multipartParts').querySelectorAll('button'))button.disabled=disabled;
  $('multipartPartPrev').disabled=busy||!multipartPlan||multipartPage===0;
  $('multipartPartNext').disabled=busy||!multipartPlan||(multipartPage+1)*PAGE_SIZE>=multipartPlan.partCount;
  $('multipartCancelRow').hidden=!multipartRunning;
  $('cancelMultipart').disabled=!multipartRunning||multipartCancelRequested;
  $('cancelMultipart').textContent=multipartCancelRequested?'Останавливаем…':'Отменить операцию с комплектом';
  document.body.setAttribute('aria-busy',String(busy));
}
function showError(error, prefix='Операция не выполнена') {
  if(error?.code==='STALE') stale=true;
  if(error?.code==='UNCERTAIN'){stale=true;uncertain=true;}
  let detail=error?.message||String(error);
  if(error?.code==='MIGRATION_BLOCKED') {reloadSuggested=true;detail='Для обновления хранилища закрой другие вкладки и прежний запуск приложения с домашнего экрана, затем нажми «Перечитать каталог». Данные браузера не очищай.';}
  else if(/blob.*(?:prepar|serializ)|(?:prepar|serializ).*blob/i.test(detail)) {reloadSuggested=true;detail='Safari не смог подготовить вложение к сохранению прежним способом. Проверь, что в шапке указана R08, закрой прежнюю вкладку и открой приложение заново. Затем повторно выбери тот же файл резервной копии. Не очищай данные Safari.';}
  else if(error?.name==='DataCloneError') {reloadSuggested=true;detail='Браузер не смог подготовить данные для локального сохранения. Проверь версию R08 в шапке и открой приложение заново. Файл резервной копии можно выбрать повторно; не очищай данные браузера.';}
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
    $('previousInfo').textContent=previous.available ? `${previous.projects} проектов · ${previous.documents} документов · ${previous.revisions} редакций. Восстановление заменит весь текущий архив, включая файлы и последующие изменения.` : 'Снимка пока нет. Он появится перед первым удалением, восстановлением, пакетной загрузкой, переносом R04 или добавлением новых записей из каталога.';
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
function matchesFormat(file,document) {
  if(document?.format==='Другое')return true;
  const name=file.name||'',extension=name.includes('.')?name.split('.').pop().toLowerCase():'';
  return !!extensionMap[document?.format]?.includes(extension);
}
function targetLabel(revisionId) {
  const revision=index.revisionsById?.get(revisionId),document=index.documentsById?.get(revision?.documentId);
  if(!revision||!document)return 'Редакция больше не найдена в архиве';
  return (index.projectNames.get(document.projectId)||'Проект')+' · '+document.name+' · '+revision.revision+' · '+document.format;
}
function rowIssue(row,targets) {
  if(row.skipped)return '';
  if(row.size>store.MAX_FILE_BYTES)return 'Файл больше '+bytes(store.MAX_FILE_BYTES)+'. Пропусти эту строку.';
  if(!row.revisionId)return row.reason==='ambiguous'?'Найдено несколько исходников. Выбери редакцию вручную или пропусти.':row.reason==='occupied'?'Совпавшая редакция уже содержит прикреплённый файл. Выбери другую редакцию или пропусти.':'Редакция не назначена. Выбери её вручную или пропусти.';
  const revision=index.revisionsById?.get(row.revisionId);
  if(!revision)return 'Назначенная редакция больше не найдена. Выбери другую или пропусти.';
  if(revision.attachment)return 'Назначенная редакция уже содержит прикреплённый файл. Он не будет заменён. Выбери другую редакцию или пропусти.';
  if(!matchesFormat(row.file,index.documentsById?.get(revision.documentId)))return 'Расширение файла не соответствует формату документа.';
  if(targets.get(row.revisionId)>1)return 'Эта редакция назначена нескольким файлам. Оставь один файл или выбери разные редакции.';
  return '';
}
function batchValidity() {
  const targets=new Map();for(const row of batchRows)if(!row.skipped&&row.revisionId)targets.set(row.revisionId,(targets.get(row.revisionId)||0)+1);
  const selected=batchRows.filter(row=>!row.skipped),size=selected.reduce((sum,row)=>sum+row.size,0);
  const issues=new Map(selected.map(row=>[row.index,rowIssue(row,targets)]));
  const errors=[...issues.values()].filter(Boolean).length,existing=snapshot?attachmentSize():0;
  return {selected,size,existing,issues,errors,ready:!!snapshot&&selected.length>0&&batchRows.length<=(store.MAX_BATCH_FILES||50)&&errors===0&&existing+size<=store.MAX_TOTAL_BYTES};
}
function batchText(text,kind='') {
  $('batchProgress').hidden=false;$('batchProgress').textContent=text;$('batchProgress').className='restore-progress'+(kind?' '+kind:'');
}
function renderBatch() {
  const validity=batchValidity();
  $('batchSummary').textContent=batchRows.length?`В списке: ${batchRows.length}; к прикреплению: ${validity.selected.length}; пропущено: ${batchRows.length-validity.selected.length}. Сохранено сейчас: ${bytes(validity.existing)}; в выбранных строках: ${bytes(validity.size)}; всего после пакета: ${bytes(validity.existing+validity.size)} из ${bytes(store.MAX_TOTAL_BYTES)}.${validity.existing+validity.size>store.MAX_TOTAL_BYTES?' Превышен лимит: пропусти часть файлов.':''}${validity.errors?' Требуют решения: '+validity.errors+'.':''}`:'Выбери файлы, чтобы подготовить список. Ничего не прикрепляется до проверки и подтверждения.';
  $('batchPreview').innerHTML=batchRows.map(row=>{
    const issue=validity.issues.get(row.index)||'';
    return `<div class="batch-row${row.skipped?' skipped':''}"><strong>${esc(row.fileName)}</strong><span class="muted"> · ${bytes(row.size)}</span><div class="row-state">${row.skipped?'Явно пропущено':row.revisionId?esc(targetLabel(row.revisionId)):'Редакция не выбрана'}</div>${!row.skipped&&!issue?'<div class="row-state">'+(row.manual?'Редакция выбрана вручную.':'Совпало имя исходника и размер. Проверь редакцию — содержимое ещё не проверялось.')+'</div>':''}${issue?'<div class="row-state row-error">'+esc(issue)+'</div>':''}<div class="actions">${row.skipped?`<button class="small ghost" data-batch-action="unskip" data-index="${row.index}">Вернуть в список</button>`:`${row.size<=store.MAX_FILE_BYTES?'<button class="small ghost" data-batch-action="choose" data-index="'+row.index+'">Выбрать редакцию</button>':''}<button class="small ghost" data-batch-action="skip" data-index="${row.index}">Пропустить</button>`}</div></div>`;
  }).join('');
}
function renderBatchTargets() {
  const row=batchRows.find(row=>row.index===batchTargetRow);if(!row||!snapshot)return;
  const query=$('batchTargetQuery').value.trim().toLocaleLowerCase('ru-RU'),project=$('batchTargetProject').value;
  const assigned=new Set(batchRows.filter(other=>other.index!==row.index&&!other.skipped&&other.revisionId).map(other=>other.revisionId));
  const candidates=snapshot.revisions.filter(revision=>{
    const document=index.documentsById.get(revision.documentId);
    if(revision.attachment||!document||project&&document.projectId!==project||!matchesFormat(row.file,document))return false;
    return [targetLabel(revision.id),revision.source?.fileName||''].join(' ').toLocaleLowerCase('ru-RU').includes(query);
  }).sort((a,b)=>Number(row.candidateIds.includes(b.id))-Number(row.candidateIds.includes(a.id)));
  const visible=candidates.slice(0,batchTargetPage*PAGE_SIZE);
  $('batchTargetList').innerHTML=visible.length?visible.map(revision=>`<button class="batch-target ghost" data-pick-revision="${esc(revision.id)}" data-unavailable="${assigned.has(revision.id)}"${assigned.has(revision.id)?' disabled':''}>${esc(targetLabel(revision.id))}${assigned.has(revision.id)?'<div class="muted">Уже выбрана для другого файла в этом списке</div>':''}</button>`).join(''):'<p class="muted">Доступных редакций не найдено. Измени поиск или проект. Редакции с прикреплённым файлом и неподходящим форматом не предлагаются.</p>';
  $('batchTargetMore').hidden=visible.length>=candidates.length;controls();
}
function openBatchTarget(rowIndex) {
  if(busy||stale)return;
  const row=batchRows.find(row=>row.index===rowIndex);if(!row)return;
  batchTargetRow=rowIndex;batchTargetPage=1;$('batchTargetFile').textContent=row.fileName+' · '+bytes(row.size);
  $('batchTargetQuery').value='';fillProjects('batchTargetProject',true);$('batchTargetProject').value='';renderBatchTargets();
  if(typeof $('batchTargetDialog').showModal==='function')$('batchTargetDialog').showModal();else $('batchTargetDialog').setAttribute('open','');
  $('batchTargetQuery').focus();
}
function closeBatchTarget() {
  if(typeof $('batchTargetDialog').close==='function')$('batchTargetDialog').close();else $('batchTargetDialog').removeAttribute('open');
  batchTargetRow=null;$('batchFiles').focus();
}
function batchStage(progress) {
  if(!restoreOperation||restoreOperation.kind!=='batch')return;
  const names={preflight:'Проверяем все файлы и назначения…',read:'Читаем выбранные файлы…',hash:'Рассчитываем SHA‑256…',write:'Проверки завершены. Сохраняем пакет и предыдущий снимок…'};
  const count=Number.isFinite(progress?.total)&&progress.total>0?' ('+progress.completed+' из '+progress.total+')':'';
  restoreOperation.text=(batchCancelRequested?'Отмена запрошена. Ожидаем безопасного завершения.\n':'')+(names[progress?.stage]||'Обрабатываем пакет…')+count;
  updateRestoreDock();
}
function renderStorageInfo() {
  $('storageInfo').textContent=snapshot?'Точный объём сохранённых вложений: '+bytes(attachmentSize())+' из '+bytes(store.MAX_TOTAL_BYTES)+'. Карточки исходников не считаются сохранёнными файлами.':'Каталог ещё не открыт; объём вложений неизвестен.';
}
async function refreshStorageEstimate() {
  const request=++storageInfoRequest,storage=globalThis.navigator?.storage;
  $('storageEstimate').textContent='Запрашиваем сведения браузера…';
  const read=async method=>{
    if(typeof storage?.[method]!=='function')return null;
    let timer;try{return await Promise.race([Promise.resolve().then(()=>storage[method]()).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),3000);})]);}finally{clearTimeout(timer);}
  };
  const [estimate,persisted]=await Promise.all([read('estimate'),read('persisted')]);
  if(request!==storageInfoRequest)return;
  const usage=estimate?.usage,quota=estimate?.quota;
  const estimateText=Number.isFinite(usage)&&usage>=0&&Number.isFinite(quota)&&quota>=0?'Оценка браузера для всего сайта: занято '+bytes(usage)+', лимит '+bytes(quota)+'.':'Оценка занятого места и лимита браузера недоступна.';
  $('storageEstimate').textContent=estimateText+' Постоянное хранилище: '+(persisted===true?'подтверждено браузером.':persisted===false?'не подтверждено браузером.':'неизвестно.');
}
function multipartText(text,kind='') {
  $('multipartProgress').hidden=false;$('multipartProgress').textContent=text;$('multipartProgress').className='restore-progress'+(kind?' '+kind:'');
}
function multipartStage(progress) {
  if(!restoreOperation||restoreOperation.kind!=='multipart')return;
  const names={export:'Подготавливаем комплект резервной копии…',check:'Проверяем состав комплекта…',read:'Читаем часть комплекта…',hash:'Проверяем контрольные суммы…',write:'Все части проверены. Сохраняем архив и предыдущий снимок…'};
  const count=Number.isFinite(progress?.total)&&progress.total>0?' ('+progress.completed+' из '+progress.total+')':'';
  restoreOperation.text=(multipartCancelRequested?'Отмена запрошена. Ожидаем безопасного завершения.\n':'')+(names[progress?.stage]||'Обрабатываем комплект…')+count;
  updateRestoreDock();
}
function releaseMultipartPlan() {
  const plan=multipartPlan;multipartPlan=null;multipartManifestRequested=false;multipartPartRequests.clear();multipartPage=0;
  if(plan)Promise.resolve().then(()=>multipart.releaseExport({plan})).catch(()=>{});
}
function renderMultipartExport() {
  if(multipartPlan&&snapshot&&multipartPlan.manifest.snapshot.version!==snapshot.version)releaseMultipartPlan();
  $('multipartExportFiles').hidden=!multipartPlan;
  if(!multipartPlan){$('multipartExportSummary').textContent='Подготовь новый комплект для текущего состояния архива.';$('multipartParts').innerHTML='';return;}
  const plan=multipartPlan,requested=multipartPartRequests.size+(multipartManifestRequested?1:0),files=plan.partCount+1;
  $('multipartExportSummary').textContent='Состояние архива №'+plan.manifest.snapshot.version+'; подготовлено '+date(plan.manifest.createdAt)+'. Данные вложений: '+bytes(plan.totalBytes)+'. Комплект: каталог и '+plan.partCount+' частей; всего файлов '+files+'. Скачивание запрошено для '+requested+' из '+files+'.'+(requested===files?' Все кнопки скачивания использованы — проверь фактическое наличие всех файлов в «Файлах».':' Скачай все файлы комплекта в одну папку.');
  $('multipartManifestState').textContent=plan.manifestName+' · '+(multipartManifestRequested?'Скачивание запрошено — проверь файл на устройстве.':'Ещё не запрашивали скачивание.');
  const start=multipartPage*PAGE_SIZE,parts=plan.manifest.parts.slice(start,start+PAGE_SIZE);
  $('multipartParts').innerHTML=parts.map((part,offset)=>{const partIndex=start+offset,requested=multipartPartRequests.has(partIndex);return `<div class="multipart-part${requested?' requested':''}"><strong>Часть ${partIndex+1} из ${plan.partCount}</strong><p>${esc(part.fileName)} · ${bytes(part.size)}</p><span>${requested?'Скачивание запрошено; проверь наличие файла.':'Нужно скачать.'}</span><div class="actions"><button class="small ghost" data-multipart-part="${partIndex}">${requested?'Скачать повторно':'Скачать часть '+(partIndex+1)}</button></div></div>`;}).join('');
  $('multipartPartPage').textContent=plan.partCount?'Части '+(start+1)+'–'+(start+parts.length)+' из '+plan.partCount:'Вложений нет: достаточно файла каталога.';
}
async function multipartRead(action,start,success,after) {
  if(busy||!snapshot||stale)return false;
  busy=true;multipartRunning=true;multipartCancelRequested=false;multipartController=new AbortController();controls();startRestore(start,'multipart');
  let ok=false;
  try{
    await new Promise(resolve=>setTimeout(resolve,0));
    const result=await action(multipartController.signal);
    if(after)after(result);
    notice(typeof success==='function'?success(result):success,'success');ok=true;renderMultipartExport();return true;
  }catch(error){showError(error,'Операция с комплектом не выполнена');return false;}
  finally{finishRestore(ok);busy=false;multipartRunning=false;multipartController=null;multipartCancelRequested=false;controls();}
}
function multipartSelectionText(selection) {
  const manifest=selection.manifest,catalog=manifest.snapshot;
  return `Комплект выбран: проектов ${catalog.projects.length}, документов ${catalog.documents.length}, редакций ${catalog.revisions.length}, частей ${manifest.parts.length}. Комплектность и заголовки проверены. Содержимое всех частей, размеры и SHA‑256 будут проверены перед заменой архива.`;
}
async function inspectMultipartFiles() {
  if(!multipartSelectedFiles.length||busy||stale)return;
  multipartSelection=null;$('multipartImportPreview').textContent='Проверяем '+multipartSelectedFiles.length+' выбранных файлов…';
  await multipartRead(signal=>multipart.inspectFiles({files:multipartSelectedFiles,onProgress:multipartStage,signal}),'Проверяем каталог и состав частей…','Комплектность проверена. Проверь состав и нажми «Проверить и восстановить».',selection=>{multipartSelection=selection;$('multipartImportPreview').textContent=multipartSelectionText(selection);});
  if(!multipartSelection)$('multipartImportPreview').textContent='Комплект не принят: '+$('message').textContent+' Выбранные файлы остаются в списке; можно повторить проверку или выбрать комплект заново.';
}
function migrationStage(progress) {
  if(!restoreOperation||restoreOperation.kind!=='migration')return;
  const names={migration:'Обновляем хранилище, сохраняя имеющийся архив…',read:'Проверяем прежние данные…',write:'Переносим файлы в новое хранилище…'};
  const count=Number.isFinite(progress?.total)&&progress.total>0?' ('+progress.completed+' из '+progress.total+')':'';
  restoreOperation.text=(names[progress?.stage]||'Открываем и проверяем хранилище…')+count;updateRestoreDock();
}
function rebuildIndex() {
  index={projectNames:new Map(snapshot.projects.map(project=>[project.id,project.name])),documentsByProject:new Map(),revisionsByDocument:new Map(),documentsById:new Map(snapshot.documents.map(doc=>[doc.id,doc])),revisionsById:new Map(snapshot.revisions.map(revision=>[revision.id,revision]))};
  for(const doc of snapshot.documents){if(!index.documentsByProject.has(doc.projectId))index.documentsByProject.set(doc.projectId,[]);index.documentsByProject.get(doc.projectId).push(doc);}
  for(const revision of snapshot.revisions){if(!index.revisionsByDocument.has(revision.documentId))index.revisionsByDocument.set(revision.documentId,[]);index.revisionsByDocument.get(revision.documentId).push(revision);}
}
function sourceMarkup(revision) {
  const source=revision.source;
  if(source?.kind!=='chatgpt-library'||!/^libfile_[a-zA-Z0-9]+$/.test(source.libraryFileId))return '';
  return `<div class="source-note"><strong>${revision.attachment?'Исходник в ChatGPT':'Исходник в ChatGPT · файл ещё не сохранён в приложении'}</strong><div style="overflow-wrap:anywhere;margin-top:4px">${esc(source.fileName)}</div>${revision.attachment?'':'<div class="muted" style="font-size:11px;margin-top:5px">Найди этот файл в самом ChatGPT и скачай на устройство. Затем нажми «Прикрепить файл» у этой редакции. Карточка исходника сама по себе не содержит файл.</div>'}</div>`;
}
async function deleteItem(type,id) {
  if(busy||stale||!snapshot)return;
  const item=(type==='project'?snapshot.projects:snapshot.documents).find(item=>item.id===id);
  if(!item)return;
  const documents=type==='project'?(index.documentsByProject.get(id)||[]):[item];
  const revisions=documents.flatMap(doc=>index.revisionsByDocument.get(doc.id)||[]);
  const files=revisions.filter(revision=>revision.attachment);
  const volume=files.reduce((sum,revision)=>sum+revision.attachment.size,0);
  const active=snapshot.documents.find(doc=>doc.id===activeDocument);
  const clearsDraft=!!active&&(type==='project'?active.projectId===id:active.id===id);
  const title=type==='project'?'проект':'документ';
  const confirmation=`Удалить ${title} «${item.name}» из приложения?\nДокументов: ${documents.length}; редакций: ${revisions.length}; сохранённых файлов: ${files.length} (${bytes(volume)}).\nИсходники ChatGPT останутся. Повторный импорт каталога может вернуть карточки.\nСохранится полный снимок с файлами. В разделе «Копия» можно вернуть ВЕСЬ архив, заменив последующие изменения. Снимок один: следующее удаление, импорт, пакетная загрузка или восстановление заменит его.${clearsDraft?'\nОткрытая форма этого документа будет очищена.':''}`;
  if(!confirm(confirmation))return;
  return run(expectedVersion=>type==='project'?store.deleteProject({projectId:id,expectedVersion}):store.deleteDocument({documentId:id,expectedVersion}),type==='project'?'Проект удалён из приложения. Предыдущий полный архив сохранён в разделе «Копия».':'Документ со всеми редакциями удалён из приложения. Предыдущий полный архив сохранён в разделе «Копия».',()=>{
    if(clearsDraft)resetRevisionForm();
    if(type==='project'&&$('projectFilter').value===id)$('projectFilter').value='';
    documentPage=1;
  });
}
function openRename(type,id,button) {
  if(busy||stale||!snapshot)return;
  const item=(type==='project'?snapshot.projects:snapshot.documents).find(item=>item.id===id);
  if(!item)return;
  renameTarget={type,id};renameFocus=button;
  $('renameTitle').textContent=type==='project'?'Название проекта':'Название документа';
  $('renameHelp').textContent=type==='project'?'Все документы, редакции и файлы останутся в этом проекте.':'Все редакции, файлы и ссылки на исходники останутся у этого документа.';
  $('renameName').value=item.name;$('renameError').hidden=true;
  if(typeof $('renameDialog').showModal==='function')$('renameDialog').showModal();else $('renameDialog').setAttribute('open','');
  controls();$('renameName').focus();$('renameName').select();
}
function closeRename() {
  if(busy)return;
  if(typeof $('renameDialog').close==='function')$('renameDialog').close();else $('renameDialog').removeAttribute('open');
  renameTarget=null;
  if(renameFocus?.isConnected)renameFocus.focus();else $('projectName').focus();
  renameFocus=null;
}
function render() {
  if(!snapshot)return;
  rebuildIndex();
  $('projectCount').textContent=snapshot.projects.length;
  $('documentCount').textContent=snapshot.documents.length;
  $('projectSummary').textContent=snapshot.revisions.length+' редакций в архиве';
  $('projectList').innerHTML=snapshot.projects.length?snapshot.projects.map(p=>{
    const groups=index.documentsByProject.get(p.id)||[];
    let revisions=0,attached=0,sources=0;
    for(const group of groups)for(const revision of index.revisionsByDocument.get(group.id)||[]){revisions++;if(revision.attachment)attached++;if(revision.source&&!revision.attachment)sources++;}
    return `<article class="project-card"><div class="project-title">${esc(p.name)}</div><div class="project-meta">Документов: ${groups.length} · Редакций: ${revisions}<br>Сохранённых файлов: ${attached} · Исходников без файла: ${sources}</div><div class="actions"><button class="small primary" data-project="${esc(p.id)}">Открыть</button><button class="small ghost" data-rename-project="${esc(p.id)}" aria-label="Переименовать проект ${esc(p.name)}">Переименовать</button><button class="small danger" data-delete-project="${esc(p.id)}" aria-label="Удалить проект ${esc(p.name)}">Удалить</button></div></article>`;
  }).join(''):'<div class="empty"><strong>Начни с первого проекта</strong><p>Собери документы и редакции одной конструкции в общем рабочем пространстве.</p></div>';
  fillProjects('docProject');fillProjects('projectFilter',true);
  if(activeDocument) {
    const group=snapshot.documents.find(d=>d.id===activeDocument);
    if(group) {$('docProject').value=group.projectId;$('docName').value=group.name;$('docFormat').value=group.format;}
    else {activeDocument=null;$('revisionFormLabel').textContent='Документ отсутствует в перечитанном каталоге';$('revisionFormTitle').textContent='Черновик редакции';$('cancelRevision').hidden=false;}
  }
  renderDocuments();
  $('backupStats').innerHTML=`<div><strong>${snapshot.projects.length}</strong><span>проектов</span></div><div><strong>${snapshot.revisions.length}</strong><span>редакций</span></div><div><strong>${attachmentCount()}</strong><span>сохранённых файлов · ${bytes(attachmentSize())}</span></div><div><strong>${snapshot.revisions.filter(r=>r.source).length}</strong><span>карточек исходников</span></div>`;
  $('eventList').innerHTML=snapshot.events?.length?snapshot.events.map(event=>`<div class="revision"><div style="overflow-wrap:anywhere">${esc(event.text)}</div><div class="muted" style="font-size:11px;margin-top:4px">${esc(/^\d{4}-\d{2}-\d{2}T/.test(event.date)?date(event.date):event.date)}</div></div>`).join(''):'<div class="empty"><strong>Журнал пока пуст</strong><p>Здесь появятся события работы с архивом.</p></div>';
  renderBatch();renderStorageInfo();renderMultipartExport();
  controls();
}
function renderDocuments() {
  if(!snapshot)return;
  const project=$('projectFilter').value;
  const sourceFilter=$('sourceFilter').value;
  const query=$('search').value.trim().toLocaleLowerCase('ru-RU');
  const groups=snapshot.documents.filter(d=>{
    if(project&&d.projectId!==project)return false;
    const name=index.projectNames.get(d.projectId)||'';
    const revs=index.revisionsByDocument.get(d.id)||[];
    if(sourceFilter==='attached'&&!revs.some(revision=>revision.attachment))return false;
    if(sourceFilter==='source'&&!revs.some(revision=>revision.source&&!revision.attachment))return false;
    return [d.name,d.format,name,...revs.flatMap(r=>[r.revision,r.status,r.attachment?.name||'',r.source?.fileName||''])].join(' ').toLocaleLowerCase('ru-RU').includes(query);
  });
  const visible=groups.slice(0,documentPage*PAGE_SIZE);
  $('documentSummary').textContent='Показано документов: '+visible.length+' из '+groups.length;
  $('showMoreDocuments').hidden=visible.length>=groups.length;
  $('documentList').innerHTML=groups.length?visible.map(group=>{
    const revisions=(index.revisionsByDocument.get(group.id)||[]).map((r,i)=>({...r,order:i})).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.order-a.order);
    const latestUpload=revisions.find(r=>r.attachment);
    const pname=index.projectNames.get(group.projectId)||'';
    return `<article class="doc-card"><div class="doc-title"><div class="title-line"><div><h3>${esc(group.name)}</h3><div class="muted">${esc(pname)} · ${revisions.length} редакций</div></div><span class="format">${esc(group.format)}</span></div></div>${revisions.map(r=>`<div class="revision"><div class="revision-top"><div><span class="revision-code">${esc(r.revision)}</span><div class="badges">${r.id===revisions[0]?.id?'<span class="badge">Последняя зарегистрированная</span>':''}${r.id===latestUpload?.id?'<span class="badge gold">Последняя с файлом</span>':''}${r.status==='Разрешено к выдаче'?'<span class="badge green">Выдача: отметка пользователя</span>':''}</div></div><label class="status-control-wrap"><span class="muted" style="font-size:10px">Статус пользователя</span><select class="status-control" aria-label="Статус ${esc(r.revision)}" data-action="status" data-id="${esc(r.id)}">${store.STATUSES.map(status=>`<option${r.status===status?' selected':''}${status==='Разрешено к выдаче'&&!r.attachment?' disabled':''}>${esc(status)}</option>`).join('')}</select></label></div><div class="muted" style="font-size:11px;margin-bottom:8px">Зарегистрировано ${esc(date(r.createdAt))}</div>${sourceMarkup(r)}${r.attachment?`<div class="file-name">${esc(r.attachment.name)}</div><div class="file-meta">${bytes(r.attachment.size)} · Файл закреплён за редакцией</div><details><summary class="file-meta">Контрольная сумма SHA‑256</summary><code class="hash">${esc(r.attachment.sha256)}</code></details><div class="actions"><button class="small ghost" data-action="download" data-id="${esc(r.id)}">Скачать файл</button></div>`:'<div class="muted">Файл ещё не прикреплён.</div><div class="actions"><button class="small ghost" data-action="attach" data-id="'+esc(r.id)+'">Прикрепить файл</button></div>'}</div>`).join('')}<div class="doc-bottom"><button class="small ghost" data-action="newRevision" data-id="${esc(group.id)}">+ Новая редакция</button><button class="small ghost" data-action="renameDocument" data-id="${esc(group.id)}">Переименовать</button><button class="small danger" data-action="deleteDocument" data-id="${esc(group.id)}" aria-label="Удалить документ ${esc(group.name)}">Удалить</button></div></article>`;
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
    render();notice(typeof success==='function'?success():success,'success');void refreshPrevious();return true;
  } catch(error) {showError(error);render();return false;}
  finally {busy=false;controls();}
}
function download(blob,name) {
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
$('prepareMultipart').addEventListener('click',async()=>{
  if(busy||stale||!snapshot)return;
  if(multipartPlan&&!confirm('Подготовить новый комплект для текущего архива? Отметки скачивания прежнего комплекта будут сброшены. Части разных комплектов нельзя смешивать.'))return;
  const expectedVersion=snapshot.version;
  await multipartRead(async signal=>{
    const old=multipartPlan;multipartPlan=null;multipartManifestRequested=false;multipartPartRequests.clear();multipartPage=0;renderMultipartExport();
    if(old)await multipart.releaseExport({plan:old});
    return multipart.prepareExport({expectedVersion,onProgress:multipartStage,signal});
  },'Подготавливаем комплект. Вложения обрабатываются по частям…','Комплект подготовлен. Теперь скачай каталог и каждую часть отдельной кнопкой.',plan=>{multipartPlan=plan;multipartManifestRequested=false;multipartPartRequests.clear();multipartPage=0;});
});
$('downloadMultipartManifest').addEventListener('click',async()=>{
  if(!multipartPlan||busy||stale)return;const plan=multipartPlan;
  await multipartRead(()=>multipart.manifestFile({plan}),'Подготавливаем файл каталога комплекта…','Скачивание каталога запрошено. Проверь, что файл сохранился в «Файлы».',result=>{download(result.blob,result.fileName);multipartManifestRequested=true;});
});
$('multipartParts').addEventListener('click',async event=>{
  if(!multipartPlan||busy||stale)return;
  const button=event.target.closest('[data-multipart-part]');if(!button)return;
  const index=Number(button.dataset.multipartPart),plan=multipartPlan;
  if(!Number.isInteger(index)||index<0||index>=plan.partCount)return;
  await multipartRead(signal=>multipart.exportPart({plan,index,signal}),'Читаем часть '+(index+1)+' из '+plan.partCount+'…','Скачивание части '+(index+1)+' запрошено. Проверь её наличие в «Файлах».',result=>{download(result.blob,result.fileName);multipartPartRequests.add(index);});
});
$('multipartPartPrev').addEventListener('click',()=>{if(busy||multipartPage===0)return;multipartPage--;renderMultipartExport();controls();});
$('multipartPartNext').addEventListener('click',()=>{if(busy||!multipartPlan||(multipartPage+1)*PAGE_SIZE>=multipartPlan.partCount)return;multipartPage++;renderMultipartExport();controls();});
$('releaseMultipartExport').addEventListener('click',async()=>{
  if(busy||!multipartPlan)return;
  const plan=multipartPlan;
  await multipartRead(()=>multipart.releaseExport({plan}),'Закрываем подготовленный комплект…','Комплект закрыт. Уже скачанные файлы на устройстве не изменялись.',()=>{multipartPlan=null;multipartManifestRequested=false;multipartPartRequests.clear();multipartPage=0;});
});
$('multipartFiles').addEventListener('change',async event=>{
  if(busy||stale)return;
  multipartSelectedFiles=Array.from(event.target.files||[]);multipartSelection=null;
  if(!multipartSelectedFiles.length){$('multipartImportPreview').textContent='Выбери каталог и все части одного комплекта.';controls();return;}
  await inspectMultipartFiles();
});
$('inspectMultipart').addEventListener('click',inspectMultipartFiles);
$('restoreMultipart').addEventListener('click',async()=>{
  if(busy||stale||!snapshot||!multipartSelection)return;
  const selection=multipartSelection;
  if(!confirm('Заменить текущий архив выбранным комплектом?\n'+multipartSelectionText(selection)+'\nТекущее состояние с файлами сохранится как один предыдущий снимок, заменив прежний. Восстановление снимка тоже заменяет ВЕСЬ архив и более поздние изменения. Следующее удаление, импорт, пакетная загрузка или восстановление заменит снимок снова.'))return;
  multipartRunning=true;multipartCancelRequested=false;multipartController=new AbortController();
  try{
    const success=await run(async expectedVersion=>{
      startRestore('Проверяем содержимое всех частей перед заменой архива…','multipart');
      await new Promise(resolve=>setTimeout(resolve,0));
      return multipart.restore({selection,expectedVersion,onProgress:multipartStage,signal:multipartController.signal});
    },'Комплект восстановлен целиком. Структура, части, размеры и SHA‑256 проверены. Предыдущий архив доступен в разделе «Копия».',()=>{resetRevisionForm();multipartSelection=null;multipartSelectedFiles=[];$('multipartFiles').value='';$('multipartImportPreview').textContent='Комплект восстановлен. Выбранные файлы на устройстве не изменялись.';});
    finishRestore(success);
  }finally{multipartRunning=false;multipartController=null;multipartCancelRequested=false;controls();}
});
$('cancelMultipart').addEventListener('click',()=>{
  if(!multipartRunning||!multipartController||multipartCancelRequested)return;
  multipartCancelRequested=true;multipartController.abort();
  if(restoreOperation?.kind==='multipart'){restoreOperation.text='Отмена запрошена. Ожидаем безопасного завершения текущей операции…';updateRestoreDock();}
  controls();
});
$('batchFiles').addEventListener('change',event=>{
  if(busy||stale||!snapshot)return;
  const files=Array.from(event.target.files||[]);if(!files.length)return;
  if(files.length>(store.MAX_BATCH_FILES||50)){event.target.value='';notice('Выбери не больше '+(store.MAX_BATCH_FILES||50)+' файлов в одном пакете.','error');return;}
  if(batchRows.length&&!confirm('Заменить текущий список выбранными файлами? Файлы из прежнего списка ещё не прикрепляются и не удаляются.')){event.target.value='';return;}
  try{
    batchRows=buildFilePlan(snapshot,files,{maxFileBytes:store.MAX_FILE_BYTES}).map(row=>({...row,skipped:false,manual:false,candidateIds:row.candidateIds||[]}));
    $('batchProgress').hidden=true;renderBatch();controls();
    notice('Список подготовлен. Проверь каждую редакцию; неразрешённые строки назначь вручную или явно пропусти.');
  }catch(error){event.target.value='';showError(error,'Не удалось подготовить пакет');}
});
$('batchPreview').addEventListener('click',event=>{
  if(busy||stale)return;
  const button=event.target.closest('[data-batch-action]');if(!button)return;
  const row=batchRows.find(row=>row.index===Number(button.dataset.index));if(!row)return;
  if(button.dataset.batchAction==='choose'){openBatchTarget(row.index);return;}
  if(button.dataset.batchAction==='skip')row.skipped=true;
  if(button.dataset.batchAction==='unskip')row.skipped=false;
  renderBatch();controls();
});
$('clearBatch').addEventListener('click',()=>{
  if(busy)return;
  batchRows=[];$('batchFiles').value='';$('batchProgress').hidden=true;renderBatch();controls();
});
$('batchTargetQuery').addEventListener('input',()=>{batchTargetPage=1;renderBatchTargets();});
$('batchTargetProject').addEventListener('change',()=>{batchTargetPage=1;renderBatchTargets();});
$('batchTargetMore').addEventListener('click',()=>{batchTargetPage++;renderBatchTargets();});
$('closeBatchTarget').addEventListener('click',closeBatchTarget);
$('batchTargetDialog').addEventListener('cancel',event=>{event.preventDefault();closeBatchTarget();});
$('batchTargetList').addEventListener('click',event=>{
  if(busy||stale)return;
  const button=event.target.closest('[data-pick-revision]');if(!button||button.disabled)return;
  const row=batchRows.find(row=>row.index===batchTargetRow);if(!row)return;
  row.revisionId=button.dataset.pickRevision;row.manual=true;row.skipped=false;
  closeBatchTarget();renderBatch();controls();
});
$('runBatch').addEventListener('click',async()=>{
  if(busy||stale||!snapshot)return;
  const validity=batchValidity();
  if(!validity.ready){batchText('Сначала разреши все строки, явно пропусти ненужные и проверь общий объём.','error');return;}
  const items=validity.selected.map(row=>({revisionId:row.revisionId,file:row.file}));
  const targets=validity.selected.slice(0,8).map(row=>'• '+row.fileName+' → '+targetLabel(row.revisionId)).join('\n');
  if(!confirm(`Прикрепить ${items.length} файлов (${bytes(validity.size)}) к проверенным редакциям?\n${targets}${items.length>8?'\n…и ещё '+(items.length-8)+' назначений из списка.':''}\nПакет сохранится целиком. Имя и размер исходника не подтверждают содержимое; SHA‑256 будет рассчитан для выбранных файлов. Имеющиеся вложения не заменяются. Сохранится один полный предыдущий снимок, заменив прежний. Следующая пакетная загрузка, удаление, импорт или восстановление снова заменит его. Восстановление заменяет весь архив.`))return;
  batchRunning=true;batchCancelRequested=false;batchController=new AbortController();
  try{
    const success=await run(async expectedVersion=>{
      startRestore('Проверяем назначения и файлы пакета…','batch');
      await new Promise(resolve=>setTimeout(resolve,0));
      return store.attachFilesAtomic({items,expectedVersion,onProgress:batchStage,signal:batchController.signal});
    },'Пакет сохранён целиком: '+items.length+' файлов. Для каждого рассчитан SHA‑256. Предыдущий полный архив доступен в разделе «Копия».',()=>{batchRows=[];$('batchFiles').value='';});
    finishRestore(success);
  }finally{batchRunning=false;batchController=null;batchCancelRequested=false;controls();}
});
$('cancelBatch').addEventListener('click',()=>{
  if(!batchRunning||!batchController||batchCancelRequested)return;
  batchCancelRequested=true;batchController.abort();
  if(restoreOperation?.kind==='batch'){restoreOperation.text='Отмена запрошена. Ожидаем безопасного завершения текущей операции…';updateRestoreDock();}
  controls();
});
$('refreshStorageInfo').addEventListener('click',()=>{renderStorageInfo();void refreshStorageEstimate();});
$('renameForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!renameTarget||busy||stale)return;
  const name=$('renameName').value.trim(),target={...renameTarget};
  if(!name){$('renameError').textContent='Укажи название.';$('renameError').hidden=false;return;}
  $('renameError').hidden=true;
  const success=await run(expectedVersion=>target.type==='project'?store.renameProject({projectId:target.id,name,expectedVersion}):store.renameDocument({documentId:target.id,name,expectedVersion}),'Название сохранено. Документы, редакции и файлы остались на месте.');
  if(success)closeRename();else{$('renameError').textContent=$('message').textContent;$('renameError').hidden=false;$('renameName').focus();}
});
$('cancelRename').addEventListener('click',closeRename);
$('renameDialog').addEventListener('cancel',event=>{event.preventDefault();closeRename();});
$('renameDialog').addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;
  const focusable=[...$('renameDialog').querySelectorAll('input,button')].filter(element=>!element.disabled);
  const first=focusable[0],last=focusable.at(-1);
  if(!first){event.preventDefault();return;}
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
$('catalogFile').addEventListener('change',async event=>{
  const file=event.target.files[0];preparedCatalog=null;$('catalogPreview').textContent='';$('catalogReceipt').textContent='';
  if(!file||busy){controls();return;}
  busy=true;controls();
  try{
    if(file.size>20*1024*1024)throw Error('Каталог проектов больше 20 МиБ.');
    const pack=JSON.parse(await readText(file));
    if(pack.app!=='RRR'||pack.kind!=='project-catalog'||pack.schemaVersion!==1||!Array.isArray(pack.projects)||!Array.isArray(pack.documents)||!Array.isArray(pack.revisions))throw Error('Ожидается каталог проектов: project-catalog, проекты, документы и редакции.');
    preparedCatalog=pack;
    $('catalogPreview').textContent='По описанию каталога: '+pack.projects.length+' проектов, '+pack.documents.length+' документов, '+pack.revisions.length+' редакций. Полная проверка связей и источников будет выполнена до добавления. Содержимое файлов в этом каталоге не хранится.';
    notice('Каталог выбран. Добавление сохранит существующие названия, статусы и вложения.');
  }catch(error){event.target.value='';showError(error,'Не удалось прочитать каталог проектов');$('catalogPreview').textContent=$('message').textContent;}
  finally{busy=false;controls();}
});
$('mergeCatalog').addEventListener('click',async()=>{
  if(!preparedCatalog||busy||stale)return;
  if(!confirm('Добавить проекты, документы и ссылки на исходники из каталога? Существующие названия, статусы и файлы сохранятся. Перед добавлением новых записей сохранится предыдущий снимок архива. Повторные записи не будут добавлены ещё раз.'))return;
  const pack=preparedCatalog;let report;
  const success=await run(async expectedVersion=>{
    const result=await store.mergeCatalogPack({pack,expectedVersion});report=result.report;return result.snapshot;
  },()=>`Каталог обработан. Добавлено: проектов ${report.addedProjects}, документов ${report.addedDocuments}, редакций ${report.addedRevisions}. Уже были в архиве: проектов ${report.skippedProjects}, документов ${report.skippedDocuments}, редакций ${report.skippedRevisions}.`);
  if(success){
    preparedCatalog=null;$('catalogFile').value='';$('catalogPreview').textContent='';
    const conflicts=Array.isArray(report.sourceConflicts)?report.sourceConflicts.length:Number(report.sourceConflicts)||0;
    $('catalogReceipt').textContent=$('message').textContent+(conflicts?' Не заменено ссылок на исходники из-за различий: '+conflicts+'. Существующие данные сохранены.':' Существующие данные сохранены.');
    controls();
  }else $('catalogReceipt').textContent=$('message').textContent;
});
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>showTab(button.dataset.tab));
$('addProject').addEventListener('click',()=>{
  const name=$('projectName').value.trim();
  if(!name)return notice('Укажи название проекта.','error');
  return run(expectedVersion=>store.addProject({name,expectedVersion}),'Проект сохранён.',()=>{$('projectName').value='';});
});
$('projectList').addEventListener('click',event=>{
  const deletion=event.target.closest('[data-delete-project]');if(deletion){deleteItem('project',deletion.dataset.deleteProject);return;}
  const rename=event.target.closest('[data-rename-project]');if(rename){openRename('project',rename.dataset.renameProject,rename);return;}
  const button=event.target.closest('[data-project]');if(!button||busy||stale)return;
  $('projectFilter').value=button.dataset.project;
  if(!activeDocument)$('docProject').value=button.dataset.project;
  $('search').value='';documentPage=1;renderDocuments();showTab('documents');
});
$('addRevision').addEventListener('click',()=>{
  const projectId=$('docProject').value,name=$('docName').value.trim(),format=$('docFormat').value,revision=$('docRevision').value.trim();
  if(!projectId||!name||!revision)return notice('Выбери проект и укажи название документа и редакцию.','error');
  return run(expectedVersion=>store.addRevision({projectId,name,format,revision,expectedVersion}),'Редакция сохранена. Теперь можно прикрепить файл.',()=>{$('docRevision').value='';});
});
$('cancelRevision').addEventListener('click',()=>{resetRevisionForm();controls();});
$('search').addEventListener('input',()=>{documentPage=1;renderDocuments();});
$('projectFilter').addEventListener('change',()=>{documentPage=1;renderDocuments();});
$('sourceFilter').addEventListener('change',()=>{documentPage=1;renderDocuments();});
$('showMoreDocuments').addEventListener('click',()=>{documentPage++;renderDocuments();});
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
  if(button.dataset.action==='deleteDocument'){await deleteItem('document',id);return;}
  if(button.dataset.action==='renameDocument'){openRename('document',id,button);return;}
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
    download(new Blob([JSON.stringify(backup)],{type:'application/json'}),'IGNIS_PRO_R08_full_'+stamp()+'.json');
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
    if(backup.app!=='RRR'||backup.kind!=='full'||![1,2,3].includes(backup.schemaVersion)||!Array.isArray(backup.snapshot?.projects)||!Array.isArray(backup.snapshot?.documents)||!Array.isArray(backup.snapshot?.revisions)||!Array.isArray(backup.manifest))throw Error('Это не полная резервная копия архива. Для каталога R04 используй отдельный перенос.');
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
  if(!confirm('Вернуть предыдущее состояние архива? Текущий каталог и вложения будут заменены. Более поздние изменения текущего архива будут потеряны. Текущее состояние станет единственным новым снимком восстановления.'))return;
  const success=await run(async expectedVersion=>{
    startRestore('Проверяем предыдущий снимок и контрольные суммы вложений…');
    await new Promise(resolve=>setTimeout(resolve,0));
    return store.restorePrevious({expectedVersion,onProgress:restoreStage});
  },'Предыдущее состояние восстановлено, контрольные суммы вложений проверены.',()=>resetRevisionForm());
  finishRestore(success);
});
$('importLegacy').addEventListener('click',()=>{
  if(busy||stale)return;
  if(!confirm('Перенести проекты, карточки документов и журнал R04 в пустой архив R08? Прежний каталог R04 останется без изменений. Оригиналов файлов в нём нет.'))return;
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
  if(!confirm('Перенести выбранный каталог R04 в пустой архив R08? Будут перенесены проекты, карточки документов и журнал. Исходный файл и прежний каталог не изменятся.'))return;
  const raw=preparedLegacy;
  return run(expectedVersion=>store.importLegacy({expectedVersion,raw}),'Каталог из файла R04 перенесён. Прикрепи оригиналы файлов к нужным редакциям.');
});
async function load(first=false) {
  if(busy)return;busy=true;controls();notice('Открываем локальный архив…');
  if(first)startRestore('Открываем и проверяем хранилище. При обновлении имеющиеся данные сохраняются…','migration');
  try {
    snapshot=await(first?store.init({onProgress:migrationStage}):store.readSnapshot());stale=false;uncertain=false;reloadSuggested=false;render();void refreshPrevious();void refreshStorageEstimate();document.body.dataset.ready='true';notice(first?'Архив открыт. Данные хранятся локально на этом устройстве.':'Каталог перечитан. Введённые поля сохранены.'+(batchRows.length?' Выбранные файлы пакета сохранены в списке; назначения проверены по текущим редакциям.':''),'success');
    if(!$('restoreProgress').hidden)restoreText('Каталог перечитан. На экране показано фактическое сохранённое состояние.','success');
    if(first)finishRestore(true);
  } catch(error){showError(error,'Не удалось открыть архив');$('reloadRow').hidden=false;if(first)finishRestore(false);}
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
