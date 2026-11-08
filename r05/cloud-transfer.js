import * as store from './store.js?v=0.8.0';
const CLOUD='https://ignis-pro-archive.major-shark-6228.chatgpt.site';
const CHANNEL='ignis-transfer-v1';
const button=document.getElementById('transferCloud');
const cancel=document.getElementById('cancelCloudTransfer');
const status=document.getElementById('cloudTransferStatus');
let session=null;
function say(text){status.textContent=text;}
async function release(s,text){
 if(session!==s)return;
 session=null;clearTimeout(s.timer);button.disabled=false;cancel.hidden=true;
 if(s.exported)await store.endExport({exportId:s.exported.exportId}).catch(()=>{});
 if(text)say(text);
}
function touch(s){clearTimeout(s.timer);s.timer=setTimeout(()=>release(s,'Связь с облаком прервалась. Исходный архив сохранён. Можно повторить перенос или использовать резервную копию.'),180000);}
button.addEventListener('click',()=>{
 if(session)return;
 const nonce=crypto.randomUUID();
 // Must happen directly in the user gesture, before opening IndexedDB.
 const popup=window.open(CLOUD+'/transfer?session='+encodeURIComponent(nonce),'ignis-cloud-transfer');
 if(!popup){say('Разреши открытие новой вкладки и повтори. Или скачай полную копию в разделе «Копия» и импортируй её в облаке.');return;}
 const s={nonce,popup,exported:null,opening:null,handling:false,timer:null};session=s;touch(s);
 button.disabled=true;cancel.hidden=false;say('Облако открыто в новой вкладке. При необходимости войди в тот же аккаунт ChatGPT. Оставь эту вкладку открытой до завершения переноса.');
});
cancel.addEventListener('click',()=>{const s=session;if(!s)return;s.popup.postMessage({channel:CHANNEL,nonce:s.nonce,type:'cancel'},CLOUD);void release(s,'Перенос остановлен. Исходный архив остался на устройстве. Если облако уже подтвердило сохранение, проверь его перед повторным переносом.');});
window.addEventListener('message',async event=>{
 const s=session,m=event.data;
 if(!s||event.origin!==CLOUD||event.source!==s.popup||!m||m.channel!==CHANNEL||m.nonce!==s.nonce)return;
 touch(s);
 if(m.type==='complete'){void release(s,'Перенос подтверждён сервером. Проекты и файлы доступны в облаке. Исходная копия на этом устройстве сохранена.');return;}
 if(m.type==='failed'||m.type==='cancel'){void release(s,'Перенос не завершён. Исходный архив сохранён. Подробности — во вкладке облака.');return;}
 if(m.type!=='request'||typeof m.requestId!=='string'||s.handling)return;
 s.handling=true;
 try{
  let result,transfer=[];
  if(m.method==='metadata'){
   if(!s.opening)s.opening=(async()=>{await store.init();return store.createExport();})();
   s.exported=await s.opening;
   if(session!==s){await store.endExport({exportId:s.exported.exportId}).catch(()=>{});return;}
   result={snapshot:s.exported.snapshot,files:s.exported.files,chunkBytes:s.exported.chunkBytes};
   say('Передаём проекты и файлы. Не закрывай эту вкладку. Новые изменения после начала переноса останутся только в локальной копии.');
  } else if(m.method==='chunk'){
   if(!s.exported)throw Error('Сначала нужен каталог');
   const file=s.exported.files.find(f=>f.revisionId===m.revisionId);
   if(!file||!Number.isInteger(m.index)||m.index<0||m.index>=file.chunkCount)throw Error('Неверный запрос блока файла');
   result=await store.readExportChunk({exportId:s.exported.exportId,revisionId:m.revisionId,index:m.index});transfer=[result];
  } else throw Error('Неизвестный запрос');
  if(session===s)s.popup.postMessage({channel:CHANNEL,nonce:s.nonce,type:'response',requestId:m.requestId,result},CLOUD,transfer);
 }catch(error){if(session===s)s.popup.postMessage({channel:CHANNEL,nonce:s.nonce,type:'response',requestId:m.requestId,error:error.message||'Ошибка чтения архива'},CLOUD);}
 finally{s.handling=false;}
});
