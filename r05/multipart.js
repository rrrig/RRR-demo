import {Sha256} from './sha256.js?v=0.8.0';
// R08 portable multipart backups. Each part is a bounded binary envelope;
// filenames are labels only, so iOS duplicate-download renaming is harmless.
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const PART_DATA_BYTES = 32 * 1024 * 1024;
export const MAX_PART_BYTES = PART_DATA_BYTES + 1024 * 1024 + 19;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_PARTS = 50000;
const MAX_CHUNKS = 50000 + Math.ceil(MAX_TOTAL_BYTES / CHUNK_BYTES);
const MAGIC = new Uint8Array([73,71,78,73,83,45,82,48,56,45,80,65,82,84,10]); // IGNIS-R08-PART\n
const PREFIX_BYTES = MAGIC.length + 4;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_SEGMENTS_PER_PART = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const fail = (code,message) => {throw Object.assign(new Error(message), {code});};
const object = (value,label) => {if(!value || typeof value!=='object' || Array.isArray(value))fail('VALIDATION',label+': ожидается объект');};
const exactKeys = (value,keys,label) => {object(value,label);if(Object.keys(value).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(value,key)))fail('VALIDATION',label+': неверные поля');};
const identifier = value => typeof value==='string' && value.length>0 && value.length<=200 && value.trim()===value && !/[\u0000-\u001f\u007f]/.test(value);
const validBackupId = value => typeof value==='string' && /^[a-f0-9]{32}$/.test(value);
const validHash = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const partName = (id,number) => 'IGNIS_PRO_R08_'+id+'_part'+String(number).padStart(6,'0')+'.rrrpart';
const manifestName = id => 'IGNIS_PRO_R08_'+id+'_manifest.json';
const cancelled = signal => {if(signal?.aborted)fail('CANCELLED','Операция отменена; архив не заменён');};
const progress = (callback,stage,completed,total) => {try{callback?.({stage,completed,total});}catch(_){/* UI callbacks cannot affect backup integrity. */}};
const headerFor = (manifest,part) => ({backupId:manifest.backupId,number:part.number,size:part.size,segments:part.segments});
const sameHeader = (header,manifest,part) => header.backupId===manifest.backupId && header.number===part.number && header.size===part.size && header.segments.length===part.segments.length && header.segments.every((segment,index)=>['revisionId','chunkIndex','offset','size','sha256'].every(key=>segment[key]===part.segments[index][key]));
function validateSegments(segments,size){
 if(!Array.isArray(segments)||segments.length<1||segments.length>MAX_SEGMENTS_PER_PART)fail('VALIDATION','Неверный список блоков части');
 let offset=0;for(const segment of segments){exactKeys(segment,['revisionId','chunkIndex','offset','size','sha256'],'Блок части');if(!identifier(segment.revisionId)||!Number.isSafeInteger(segment.chunkIndex)||segment.chunkIndex<0||!Number.isSafeInteger(segment.size)||segment.size<1||segment.size>CHUNK_BYTES||segment.offset!==offset||!validHash(segment.sha256))fail('VALIDATION','Неверные сведения или порядок блоков части');offset+=segment.size;}
 if(offset!==size||size>PART_DATA_BYTES)fail('VALIDATION','Неверный общий размер блоков части');
}

function validateManifest(manifest) {
  exactKeys(manifest,['app','kind','schemaVersion','backupId','createdAt','chunkBytes','snapshot','parts','totalBytes'],'Манифест');
  if(manifest.app!=='RRR' || manifest.kind!=='multipart' || manifest.schemaVersion!==1 || !validBackupId(manifest.backupId) || manifest.chunkBytes!==CHUNK_BYTES)fail('VALIDATION','Это не поддерживаемая составная копия R08');
  if(typeof manifest.createdAt!=='string' || !Number.isFinite(Date.parse(manifest.createdAt)) || new Date(manifest.createdAt).toISOString()!==manifest.createdAt)fail('VALIDATION','Неверная дата составной копии');
  const snapshot=manifest.snapshot;object(snapshot,'Каталог копии');
  if(snapshot.schemaVersion!==3 || !Number.isSafeInteger(snapshot.version) || snapshot.version<0)fail('VALIDATION','Неверная версия каталога составной копии');
  for(const key of ['projects','documents','revisions','events'])if(!Array.isArray(snapshot[key]) || snapshot[key].length>50000)fail('VALIDATION','Неверный список '+key+' составной копии');
  if(!Array.isArray(manifest.parts) || manifest.parts.length>MAX_PARTS)fail('LIMIT','В составной копии слишком много частей');
  const expected=new Map(),seenRevisions=new Set();let totalBytes=0,expectedParts=0;
  for(const revision of snapshot.revisions){
    object(revision,'Редакция');if(!identifier(revision.id) || seenRevisions.has(revision.id))fail('VALIDATION','Неверный или повторный ID редакции');seenRevisions.add(revision.id);
    if(revision.attachment===null)continue;
    const attachment=revision.attachment;object(attachment,'Вложение');
    if(!Number.isSafeInteger(attachment.size) || attachment.size<0 || attachment.size>MAX_FILE_BYTES || !validHash(attachment.sha256))fail('VALIDATION','Неверный размер или SHA-256 вложения');
    totalBytes+=attachment.size;const count=Math.ceil(attachment.size/CHUNK_BYTES);expectedParts+=count;expected.set(revision.id,{size:attachment.size,count,indices:new Set()});
  }
  if(!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes!==totalBytes || totalBytes>MAX_TOTAL_BYTES)fail('LIMIT','Неверный или превышенный общий объём составной копии');
  let actualChunks=0;const nextIndices=new Map();
  for(let index=0;index<manifest.parts.length;index++){
    const part=manifest.parts[index];exactKeys(part,['number','fileName','size','segments'],'Часть копии');
    if(part.number!==index+1 || part.fileName!==partName(manifest.backupId,index+1) || !Number.isSafeInteger(part.size) || part.size<1 || part.size>PART_DATA_BYTES)fail('VALIDATION','Неверный номер, имя или размер части копии');
    validateSegments(part.segments,part.size);
    for(const segment of part.segments){
      const file=expected.get(segment.revisionId),next=nextIndices.get(segment.revisionId)||0;
      if(!file || segment.chunkIndex>=file.count || file.indices.has(segment.chunkIndex) || segment.chunkIndex!==next || segment.size!==Math.min(CHUNK_BYTES,file.size-segment.chunkIndex*CHUNK_BYTES))fail('VALIDATION','Неверный, пропущенный или повторный блок файла');
      file.indices.add(segment.chunkIndex);nextIndices.set(segment.revisionId,next+1);actualChunks++;
    }
  }
  if(actualChunks!==expectedParts)fail('VALIDATION','В манифесте не хватает блоков файлов или есть лишние блоки');
  return manifest;
}

export function createMultipart(store,options={}) {
  const crypt=options.crypto||globalThis.crypto;
  const readTimeoutMs=Math.max(1,options.readTimeoutMs??30000);
  const hashTimeoutMs=Math.max(1,options.hashTimeoutMs??60000);
  const activePlans=new WeakMap();
  function bounded(produce,label,ms,signal) {
    cancelled(signal);
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);error?reject(error):resolve(value);};
      const onAbort=()=>finish(Object.assign(new Error('Операция отменена; архив не заменён'),{code:'CANCELLED'}));
      const timer=setTimeout(()=>finish(Object.assign(new Error(label+': превышено время ожидания'),{code:'TIMEOUT'})),ms);
      signal?.addEventListener('abort',onAbort,{once:true});
      Promise.resolve().then(()=>{cancelled(signal);return produce();}).then(value=>finish(null,value),error=>finish(error));
    });
  }
  async function hash(bytes,signal) {
    if(!crypt?.subtle?.digest)fail('UNSUPPORTED','Для проверки частей копии нужен Web Crypto через HTTPS');
    const result=await bounded(()=>crypt.subtle.digest('SHA-256',bytes),'Проверка SHA-256 части',hashTimeoutMs,signal);
    return Array.from(new Uint8Array(result),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  async function readBytes(file,start,end,signal) {
    cancelled(signal);
    if(!file || typeof file.slice!=='function' || typeof file.size!=='number')fail('VALIDATION','Выбери файлы составной резервной копии');
    const slice=file.slice(start,end);
    const bytes=await bounded(()=>slice.arrayBuffer(),'Чтение части резервной копии',readTimeoutMs,signal);
    if(!(bytes instanceof ArrayBuffer) || bytes.byteLength!==end-start)fail('VALIDATION','Часть резервной копии прочитана не полностью');
    cancelled(signal);return bytes;
  }
  async function readHeader(file,signal) {
    if(!Number.isSafeInteger(file?.size) || file.size<PREFIX_BYTES || file.size>PART_DATA_BYTES+MAX_HEADER_BYTES+PREFIX_BYTES)fail('LIMIT','Неверный размер файла части');
    const prefix=await readBytes(file,0,PREFIX_BYTES,signal),view=new Uint8Array(prefix);
    if(!MAGIC.every((value,index)=>view[index]===value))fail('VALIDATION','Файл не является частью копии IGNIS PRO R08');
    const length=new DataView(prefix).getUint32(MAGIC.length,false);
    if(length<1 || length>MAX_HEADER_BYTES || PREFIX_BYTES+length>file.size)fail('VALIDATION','Повреждён заголовок части');
    let header;try{header=JSON.parse(decoder.decode(await readBytes(file,PREFIX_BYTES,PREFIX_BYTES+length,signal)));}catch(error){if(error?.code)throw error;fail('VALIDATION','Не удалось прочитать заголовок части');}
    exactKeys(header,['backupId','number','size','segments'],'Заголовок части');
    if(!validBackupId(header.backupId) || !Number.isSafeInteger(header.number) || header.number<1 || header.number>MAX_PARTS || !Number.isSafeInteger(header.size) || header.size<1 || header.size>PART_DATA_BYTES || file.size!==PREFIX_BYTES+length+header.size)fail('VALIDATION','Неверные сведения или размер части');
    validateSegments(header.segments,header.size);
    return {header,offset:PREFIX_BYTES+length};
  }
  async function releaseExport({plan}) {
    if(!plan || !activePlans.has(plan))return;
    const internal=activePlans.get(plan);activePlans.delete(plan);
    await store.endExport({exportId:internal.exportId});
  }
  async function prepareExport({expectedVersion,onProgress,signal}={}) {
    cancelled(signal);progress(onProgress,'export',0,0);
    const source=await store.createExport({expectedVersion});let plan;
    try{
      cancelled(signal);
      if(!source || !Array.isArray(source.files) || source.chunkBytes!==CHUNK_BYTES)fail('VALIDATION','Хранилище вернуло несовместимый формат частей');
      if(!crypt?.getRandomValues)fail('UNSUPPORTED','Недоступен генератор идентификатора резервной копии');
      const idBytes=new Uint8Array(16);crypt.getRandomValues(idBytes);const backupId=Array.from(idBytes,byte=>byte.toString(16).padStart(2,'0')).join('');
      const manifest={app:'RRR',kind:'multipart',schemaVersion:1,backupId,createdAt:new Date().toISOString(),chunkBytes:CHUNK_BYTES,snapshot:structuredClone(source.snapshot),parts:[],totalBytes:0};
      const sourceRevisions=new Map((source.snapshot?.revisions||[]).filter(revision=>revision.attachment).map(revision=>[revision.id,revision.attachment]));
      if(source.files.length!==sourceRevisions.size)fail('VALIDATION','Хранилище вернуло неполный список файлов');
      const seenFiles=new Set();
      const total=source.files.reduce((sum,file)=>sum+file.chunkCount,0);if(!Number.isSafeInteger(total)||total<0||total>MAX_CHUNKS)fail('LIMIT','Для этой копии требуется слишком много блоков');
      let completed=0;progress(onProgress,'hash',0,total);
      for(const file of source.files){
        const wholeFile=new Sha256(),attachment=sourceRevisions.get(file.revisionId);
        if(!attachment || seenFiles.has(file.revisionId) || ['name','type','size','sha256'].some(key=>file[key]!==attachment[key]))fail('VALIDATION','Сведения файла не соответствуют каталогу');
        seenFiles.add(file.revisionId);
        manifest.totalBytes+=file.size;
        if(!identifier(file.revisionId) || !Number.isSafeInteger(file.size) || file.size<0 || file.size>MAX_FILE_BYTES || file.chunkCount!==Math.ceil(file.size/CHUNK_BYTES))fail('VALIDATION','Хранилище вернуло неверные сведения о файле');
        for(let chunkIndex=0;chunkIndex<file.chunkCount;chunkIndex++){
          cancelled(signal);const bytes=await store.readExportChunk({exportId:source.exportId,revisionId:file.revisionId,index:chunkIndex});cancelled(signal);
          const size=Math.min(CHUNK_BYTES,file.size-chunkIndex*CHUNK_BYTES);
          if(!(bytes instanceof ArrayBuffer) || bytes.byteLength!==size)fail('VALIDATION','Сохранённая часть файла имеет неверный размер');
          wholeFile.update(bytes);
          const sha256=await hash(bytes,signal);let part=manifest.parts.at(-1);
          if(!part || part.size+size>PART_DATA_BYTES || part.segments.length>=MAX_SEGMENTS_PER_PART){const number=manifest.parts.length+1;part={number,fileName:partName(backupId,number),size:0,segments:[]};manifest.parts.push(part);}
          part.segments.push({revisionId:file.revisionId,chunkIndex,offset:part.size,size,sha256});part.size+=size;completed++;progress(onProgress,'hash',completed,total);
        }
        if(wholeFile.digestHex()!==file.sha256)fail('VALIDATION','Сохранённый файл не прошёл полную проверку SHA-256; составная копия не подготовлена');
      }
      validateManifest(manifest);const manifestText=JSON.stringify(manifest);
      if(encoder.encode(manifestText).byteLength>MAX_MANIFEST_BYTES)fail('LIMIT','Манифест копии больше 32 МиБ');
      plan={manifest,exportId:source.exportId,partCount:manifest.parts.length,totalBytes:manifest.totalBytes,manifestName:manifestName(backupId)};
      activePlans.set(plan,{exportId:source.exportId,manifest:structuredClone(manifest),manifestText});
      return plan;
    }catch(error){try{await store.endExport({exportId:source.exportId});}catch(_){}throw error;}
  }
  function checkedPlan(plan) {
    const internal=plan && activePlans.get(plan);if(!internal)fail('NOT_FOUND','Подготовь составную копию заново');return internal;
  }
  function manifestFile({plan}) {
    const internal=checkedPlan(plan);
    return {blob:new Blob([internal.manifestText],{type:'application/json'}),fileName:manifestName(internal.manifest.backupId)};
  }
  async function exportPart({plan,index,signal}) {
    const internal=checkedPlan(plan),manifest=internal.manifest;
    if(!Number.isSafeInteger(index) || index<0 || index>=manifest.parts.length)fail('VALIDATION','Неверный номер части');
    cancelled(signal);const part=manifest.parts[index],pieces=[];
    const header=encoder.encode(JSON.stringify(headerFor(manifest,part))),prefix=new Uint8Array(PREFIX_BYTES);prefix.set(MAGIC);new DataView(prefix.buffer).setUint32(MAGIC.length,header.byteLength,false);
    if(header.byteLength>MAX_HEADER_BYTES)fail('LIMIT','Заголовок части слишком большой');
    pieces.push(prefix,header);
    for(const segment of part.segments){
      cancelled(signal);const bytes=await store.readExportChunk({exportId:internal.exportId,revisionId:segment.revisionId,index:segment.chunkIndex});cancelled(signal);
      if(!(bytes instanceof ArrayBuffer) || bytes.byteLength!==segment.size || await hash(bytes,signal)!==segment.sha256)fail('VALIDATION','Сохранённый блок файла не прошёл проверку SHA-256');
      pieces.push(bytes);
    }
    return {blob:new Blob(pieces,{type:'application/octet-stream'}),fileName:part.fileName};
  }

  async function inspectFiles({files,onProgress,signal}) {
    cancelled(signal);if(!files || typeof files[Symbol.iterator]!=='function')fail('VALIDATION','Выбери манифест JSON и все файлы частей');
    const list=Array.from(files);if(list.length<1 || list.length>MAX_PARTS+1)fail('LIMIT','Выбери один манифест и допустимое число частей');
    const candidates=list.filter(file=>typeof file?.name==='string' && /\.json$/i.test(file.name));
    if(candidates.length!==1)fail('VALIDATION','Нужно выбрать ровно один манифест JSON вместе со всеми его частями');
    const manifestFile=candidates[0];if(!Number.isSafeInteger(manifestFile.size) || manifestFile.size<2 || manifestFile.size>MAX_MANIFEST_BYTES)fail('LIMIT','Манифест копии должен быть не больше 32 МиБ');
    let manifest;try{manifest=JSON.parse(decoder.decode(await readBytes(manifestFile,0,manifestFile.size,signal)));}catch(error){if(error?.code)throw error;fail('VALIDATION','Не удалось прочитать манифест JSON');}
    validateManifest(manifest);
    if(list.length!==manifest.parts.length+1)fail('VALIDATION','Выбраны не все части копии или присутствуют лишние файлы. Нужно частей: '+manifest.parts.length);
    const partFiles=new Array(manifest.parts.length);let completed=0;progress(onProgress,'check',0,manifest.parts.length);
    for(const file of list){
      if(file===manifestFile)continue;
      const {header}=await readHeader(file,signal),part=manifest.parts[header.number-1];
      if(!part || !sameHeader(header,manifest,part))fail('VALIDATION','Выбрана часть из другой копии или её заголовок повреждён');
      if(partFiles[header.number-1])fail('VALIDATION','Одна часть копии выбрана повторно');
      partFiles[header.number-1]=file;progress(onProgress,'check',++completed,manifest.parts.length);
    }
    if(partFiles.some(file=>!file))fail('VALIDATION','Не хватает частей копии');
    cancelled(signal);return {manifest,partFiles};
  }
  async function restore({selection,expectedVersion,onProgress,signal}) {
    cancelled(signal);object(selection,'Выбранная копия');
    // Clone metadata before the first await; external UI changes cannot redirect data.
    const manifest=validateManifest(structuredClone(selection.manifest));
    if(!Array.isArray(selection.partFiles) || selection.partFiles.length!==manifest.parts.length || selection.partFiles.some(file=>!file))fail('VALIDATION','Не хватает выбранных частей копии');
    const files=selection.partFiles.slice();let restoreId;
    try{
      // Verify all envelopes again before creating a staging session.
      for(let index=0;index<files.length;index++){
        const {header}=await readHeader(files[index],signal);if(!sameHeader(header,manifest,manifest.parts[index]))fail('VALIDATION','Список выбранных частей изменился');
      }
      cancelled(signal);const staged=await store.beginRestore({snapshot:manifest.snapshot,expectedVersion});restoreId=staged.restoreId;
      if(staged.chunkBytes!==CHUNK_BYTES)fail('VALIDATION','Хранилище ожидает другой размер частей');
      progress(onProgress,'read',0,files.length);
      for(let index=0;index<files.length;index++){
        cancelled(signal);const file=files[index],part=manifest.parts[index],{header,offset}=await readHeader(file,signal);
        if(!sameHeader(header,manifest,part))fail('VALIDATION','Заголовок части изменился');
        for(const segment of part.segments){
          const bytes=await readBytes(file,offset+segment.offset,offset+segment.offset+segment.size,signal);
          if(bytes.byteLength!==segment.size || await hash(bytes,signal)!==segment.sha256)fail('VALIDATION','Часть '+part.number+' не прошла проверку SHA-256. Архив не заменён');
          cancelled(signal);await store.stageRestoreChunk({restoreId,revisionId:segment.revisionId,index:segment.chunkIndex,bytes,signal});cancelled(signal);
        }
        progress(onProgress,'read',index+1,files.length);
      }
      cancelled(signal);progress(onProgress,'hash',0,manifest.snapshot.revisions.filter(revision=>revision.attachment).length);
      const snapshot=await store.finishRestore({restoreId,onProgress,signal});restoreId=null;return snapshot;
    }catch(error){
      if(restoreId && error?.code!=='UNCERTAIN'){try{await store.cancelRestore({restoreId});}catch(_) {/* A failed cleanup leaves only inaccessible staging data; core can reclaim it. */}}
      throw error;
    }
  }
  return {prepareExport,exportPart,manifestFile,releaseExport,inspectFiles,restore};
}
