/* Employee dossier. All durable writes go through the payroll vault. */
(() => {
  'use strict';
  const esc = value => window.PayrollCore.escapeHtml(value);
  const MiB = 1024 * 1024;
  const imageData = /^data:image\/(jpeg|png);base64,[a-zA-Z0-9+/=]+$/;
  const pdfData = /^data:application\/pdf;base64,[a-zA-Z0-9+/=]+$/;
  const types = ['Паспорт', 'Трудовой договор', 'СНИЛС', 'ИНН', 'Патент', 'Разрешение на работу', 'Удостоверение', 'Другой документ'];
  const copy = value => JSON.parse(JSON.stringify(value));
  const button = (title, act, extra='') => `<button type="button" data-person="${act}" ${extra}>${esc(title)}</button>`;
  const fileControl = (label, mode, accept, extra='') => `<label class="pf-picker">${esc(label)}<input class="profile-file" type="file" data-file="${mode}" accept="${accept}" ${extra}></label>`;
  const sizes = bytes => bytes < MiB ? Math.ceil(bytes / 1024) + ' КБ' : (bytes / MiB).toFixed(1).replace('.', ',') + ' МБ';
  const field = (label, name, value, type='text') => `<label class="pf-field">${esc(label)}<input name="${name}" type="${type}" maxlength="250" value="${esc(value)}"></label>`;
  function dataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error('Файл не удалось прочитать. Выберите его ещё раз.'));
      reader.readAsDataURL(file);
    });
  }
  async function picture(file, portrait) {
    if (file.size > 35 * MiB) throw Error('Выберите изображение размером до 35 МБ.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      try { await image.decode(); } catch { throw Error('Не удалось открыть изображение. Выберите JPEG или PNG.'); }
      const side = portrait ? 600 : 2200;
      const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL('image/jpeg', portrait ? 0.83 : 0.91);
      if (!imageData.test(result)) throw Error('Не удалось подготовить изображение.');
      return result;
    } finally { URL.revokeObjectURL(url); }
  }
  async function attachment(file) {
    if (!file.size) throw Error('Выбранный файл пуст.');
    const bytes = new Uint8Array(await file.slice(0,5).arrayBuffer());
    const pdf = String.fromCharCode(...bytes) === '%PDF-';
    let data, name = file.name;
    if (pdf) {
      if (file.size > 8 * MiB) throw Error('Размер одного PDF должен быть до 8 МБ.');
      data = await dataUrl(new Blob([file], {type:'application/pdf'}));
    } else {
      data = await picture(file, false);
      name = name.replace(/\.[^.]*$/, '') + '.jpg';
    }
    return {name, data, size:Math.floor(data.split(',')[1].replace(/=+$/, '').length * 0.75)};
  }
  function blobUrl(item) {
    if (!imageData.test(item.data) && !pdfData.test(item.data)) throw Error('Неизвестный формат вложения.');
    const [head, raw] = item.data.split(',');
    const binary = atob(raw);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], {type:head.slice(5,-7)}));
  }
  function open({employee, commit, summary, payItems, editInfo, anchor}) {
    const root = document.getElementById('modal-root');
    const dialog = document.createElement('dialog');
    dialog.className = 'person-panel';
    dialog.setAttribute('aria-label', 'Карточка сотрудника');
    root.textContent = '';
    root.appendChild(dialog);
    let profile = copy(employee.profile || {});
    if (!Array.isArray(profile.documents)) profile.documents = [];
    let section = 'profile', edit = null, editIndex = -1, preview = null, viewUrl = null, busy = false, dirty = false;
    function clearUrl() { if (viewUrl) URL.revokeObjectURL(viewUrl); viewUrl = null; }
    function clear() {
      clearUrl();
      dialog.remove();
      const candidates = Array.from(document.querySelectorAll('[data-action="person-profile"]'));
      const focusTarget = anchor?.isConnected ? anchor : candidates.find(el => el.dataset.id === employee.id && el.getClientRects().length);
      focusTarget?.focus({preventScroll:true});
    }
    function discard() { return !dirty || confirm('Закрыть редактор без сохранения изменений документа?'); }
    function message(text, error=false) {
      const el = dialog.querySelector('[data-feedback]');
      if (el) { el.textContent = text; el.classList.toggle('pf-error',error); }
    }
    function setBusy(value) {
      busy = value;
      const form = dialog.querySelector('.pf-controls');
      if (form) form.inert = value;
      dialog.setAttribute('aria-busy', String(value));
    }
    async function save(next) {
      if (JSON.stringify(next).length > 16 * MiB) throw Error('В карточке более 12 МБ вложений. Удалите лишние страницы или уменьшите PDF.');
      await commit(next);
      profile = next;
    }
    function details() {
      const values = [['Телефон',employee.phone],['Дата рождения',employee.dob],['Гражданство',employee.citizenship],['Дата приёма',employee.joined],['Тип оплаты',employee.payType],['Банк / карта',employee.bank],['Заметки',employee.notes]];
      return `<section class="pf-section"><h3>Личные сведения</h3><dl>${values.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v || '—')}</dd></div>`).join('')}</dl>${button('Редактировать сведения','edit-info')}</section>
      <section class="pf-section"><h3>Фотография сотрудника</h3><div class="pf-actions">${fileControl('Выбрать фото','portrait','image/*')}${fileControl('Снять фото','portrait','image/*','capture="user"')}${profile.photo ? button('Убрать фото','remove-photo') : ''}</div></section>`;
    }
    function documents() {
      return `<section class="pf-section"><div class="pf-row"><h3>Документы</h3>${button('Добавить документ','new','class="pf-primary"')}</div>
        ${employee.documents ? `<p class="pf-legacy"><b>Сведения из прежней карточки</b><br>${esc(employee.documents)}</p>` : ''}
        ${profile.documents.length ? profile.documents.map((d,i)=>`<button class="pf-doc" data-person="document" data-index="${i}"><strong>${esc(d.title || d.kind)}</strong><span>${esc([d.number && '№ '+d.number,d.expires && 'до '+d.expires].filter(Boolean).join(' · '))}</span><small>Вложений · ${d.attachments?.length || 0}</small></button>`).join('') : '<p class="pf-muted">Здесь можно хранить реквизиты, сканы и PDF сотрудника.</p>'}</section>`;
    }
    function editor() {
      const files = edit.attachments.map((f,i)=>`<li><button type="button" class="pf-file-open" data-person="preview" data-index="${i}">${esc(f.name)} <small>${esc(sizes(f.size || 0))}</small></button>${button('Убрать','detach',`data-index="${i}" aria-label="Убрать вложение ${i+1}"`)}</li>`).join('');
      return `<section class="pf-section"><h3>${editIndex < 0 ? 'Новый документ' : 'Карточка документа'}</h3><form class="pf-form">
      <label class="pf-field">Вид документа<select name="kind">${types.map(t=>`<option ${t===edit.kind?'selected':''}>${esc(t)}</option>`).join('')}</select></label>
      ${field('Название (при необходимости)','title',edit.title)}${field('Серия и номер','number',edit.number)}${field('Кем выдан','issuer',edit.issuer)}
      ${field('Дата выдачи','issued',edit.issued,'date')}${field('Действителен до','expires',edit.expires,'date')}
      <label class="pf-field pf-wide">Примечание<textarea name="note" maxlength="1200" rows="2">${esc(edit.note)}</textarea></label>
      <div class="pf-wide"><h4>Вложения</h4><p class="pf-formats">Фотографии страниц или PDF до 8 МБ. Для сканов подойдут JPEG и PNG.</p><ul class="pf-files">${files}</ul><div class="pf-actions">${fileControl('Добавить файлы','pages','.pdf,image/*','multiple')}${fileControl('Снять страницу','pages','image/*','capture="environment"')}</div></div>
      <div class="pf-actions pf-wide"><button class="pf-primary" type="submit">Сохранить документ</button>${button('Назад','back')}${editIndex >= 0 ? button('Удалить документ','delete','class="pf-danger"') : ''}</div></form></section>`;
    }
    function render() {
      clearUrl();
      let body;
      if (preview) {
        viewUrl = blobUrl(preview);
        body = `<section class="pf-section"><div class="pf-row">${button('Назад к документу','unpreview')}<a href="${viewUrl}" download="${esc(preview.name)}">Скачать</a></div><h3>${esc(preview.name)}</h3>${imageData.test(preview.data) ? `<img class="pf-preview" src="${viewUrl}" alt="Страница документа">` : `<iframe class="pf-pdf" src="${viewUrl}" title="Просмотр PDF"></iframe><a href="${viewUrl}" target="_blank" rel="noopener noreferrer">Открыть PDF отдельно</a>`}</section>`;
      } else if (edit) body = editor();
      else if (section === 'profile') body = details();
      else if (section === 'documents') body = documents();
      else body = `<section class="pf-section"><h3>Расчёт за выбранный месяц</h3>${Array.isArray(payItems) && payItems.length ? `<dl>${payItems.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : `<p class="pf-summary">${esc(summary || 'Нет начислений за выбранный период.')}</p>`}</section>`;
      const initials = employee.name.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
      dialog.innerHTML = `<div class="pf-controls"><header class="pf-header"><span>Карточка сотрудника</span>${button('Закрыть','close')}</header>
      <div class="pf-person"><div class="pf-avatar">${imageData.test(profile.photo || '') ? `<img src="${esc(profile.photo)}" alt="">` : esc(initials)}</div><div><h2>${esc(employee.name)}</h2><p>${esc(employee.position || 'Должность не указана')}</p></div></div>
      ${window.IGNIS_PAYROLL_DEMO ? '<p class="pf-demo">Для теста используйте вымышленные фотографии и документы.</p>' : ''}
      ${edit || preview ? '' : `<nav class="pf-tabs" aria-label="Карточка сотрудника">${[['profile','Профиль'],['pay','Расчёты'],['documents','Документы']].map(([key,title])=>button(title,'section',`data-key="${key}" aria-pressed="${section===key}"`)).join('')}</nav>`}${body}</div><div class="pf-feedback" data-feedback role="status" aria-live="polite"></div>`;
      setBusy(busy);
    }
    dialog.addEventListener('cancel', e=>{e.preventDefault();if(!busy && discard())clear();});
    dialog.addEventListener('input', e=>{
      if(edit && e.target.name) { edit[e.target.name] = e.target.value; dirty = true; }
    });
    dialog.addEventListener('change', async e=>{
      if(edit && e.target.name) {edit[e.target.name]=e.target.value;dirty=true;}
      const input=e.target;
      if(!input.dataset.file || busy || !input.files.length)return;
      const files=Array.from(input.files);input.value='';
      setBusy(true);message('Подготовка файлов…');
      try {
        if(input.dataset.file==='portrait') {
          const photo=await picture(files[0],true);
          await save({...profile,photo});render();message('Фото сохранено.');
        } else {
          const additional=[];
          let total=edit.attachments.reduce((sum,f)=>sum+f.size,0);
          for(const file of files) {
            const item=await attachment(file);
            total+=item.size;
            if(total>12*MiB)throw Error('Общий размер вложений документа превышает 12 МБ.');
            additional.push(item);
          }
          edit.attachments.push(...additional);dirty=true;render();message('Файлы добавлены. Сохраните документ.');
        }
      } catch(err){message(err.message,true);} finally {setBusy(false);}
    });
    dialog.addEventListener('submit', async e=>{
      e.preventDefault();if(!edit || busy)return;
      if(edit.issued && edit.expires && edit.expires < edit.issued) {message('Окончание срока действия должно быть после даты выдачи.',true);return;}
      const docs = [...profile.documents];
      docs[editIndex < 0 ? docs.length : editIndex] = edit;
      setBusy(true);message('Сохранение…');
      try { await save({...profile,documents:docs});edit=null;dirty=false;render();message('Документ сохранён.'); }
      catch(err){message(err.message,true);}finally{setBusy(false);}
    });
    dialog.addEventListener('click', async e=>{
      const bt=e.target.closest('[data-person]');if(!bt || busy)return;
      const act=bt.dataset.person, i=Number(bt.dataset.index);
      try {
        if(act==='close'){if(discard())clear();return;}
        if(act==='edit-info'){
          clear();editInfo();return;
        }
        if(act==='section') section=bt.dataset.key;
        if(act==='new' || act==='document') {
          editIndex=act==='new'?-1:i;
          edit=editIndex<0?{kind:types[0],attachments:[]}:copy(profile.documents[i]);
          if(!Array.isArray(edit.attachments))edit.attachments=[];
          dirty=false;
        }
        if(act==='back'){if(!discard())return;edit=null;dirty=false;}
        if(act==='preview') preview=edit.attachments[i];
        if(act==='unpreview') preview=null;
        if(act==='detach'){edit.attachments.splice(i,1);dirty=true;}
        if(act==='delete' || act==='remove-photo'){
          if(!confirm(act==='delete'?'Удалить документ и его вложения?':'Убрать фотографию сотрудника?'))return;
          setBusy(true);
          await save(act==='delete'?{...profile,documents:profile.documents.filter((d,n)=>n!==editIndex)}:{...profile,photo:null});
          edit=null;dirty=false;
        }
        render();
        if(act==='section') dialog.querySelector('[aria-pressed="true"]').focus();
        else if(act==='new'||act==='document')dialog.querySelector('select')?.focus();
        if(act==='remove-photo'||act==='delete')message('Изменения сохранены.');
      }catch(err){message(err.message,true);}finally{setBusy(false);}
    });
    render(); dialog.showModal();
  }
  window.PersonProfile = {open};
})();
