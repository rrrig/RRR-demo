/* Восстановленная версия. Интерфейс и редактирование локальных данных; сетевых запросов нет. */
(function(){
'use strict';
const C=window.PayrollCore; const Excel=window.PayrollExcel;
const by=id=>document.getElementById(id); const H=C.escapeHtml;
let base=window.PayrollSeed, state=null,tab='sheet',journalScope='all',lastSearch='',localOk=true,renderCount=0;
function save(message){
 const snapshot=C.copy(state);
 window.PayrollVault.persist(snapshot).then(()=>{localOk=true;if(message)toast(message);},err=>{
  localOk=false;toast('Ошибка защищённого сохранения: '+err.message,'error');
 });
}
function audit(message){state.audit=state.audit||[];state.audit.unshift({at:new Date().toISOString(),message});state.audit=state.audit.slice(0,150);}
function toast(message,type='ok'){const el=by('toast');el.textContent=message;el.className='toast'+(type==='error'?' error':'');el.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>{el.style.display='none';},3400);}
function download(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}
const jsonFile=(name,obj)=>download(name,new Blob([JSON.stringify(obj,null,2)],{type:'application/json;charset=utf-8'}));
const prefix=()=>`ЗП_${state.activeMonth.replace('-','_')}`;
function btn(label,action,cls='btn-secondary',extra=''){return `<button type="button" class="btn ${cls}" data-action="${action}" ${extra}>${label}</button>`;}
function nextButton(){const k=C.nextMonth(state.activeMonth);return btn(state.months[k]?`→ ${H(C.monthLabel(k))}`:'＋ Следующий месяц','next-month','btn-secondary');}
function rowInput(empId,field,val,fmt='',title=''){const v=val===null||val===undefined?'':val;return `<input aria-label="${H(title||field)}" title="${H(title||field)}" class="editable ${field==='note'?'wide-edit':''}" type="${field==='note'?'text':'number'}" ${field==='note'?'maxlength="350"':'step="any" min="0" inputmode="decimal"'} data-scope="row" data-id="${H(empId)}" data-field="${field}" value="${H(v)}" />`;}
function renderHeader(){
 const key=state.activeMonth, month=state.months[key], period=C.monthlyPeriod(key);
 const date=value=>value.split('-').reverse().join('.');
 const options=Object.keys(state.months).sort().map(value=>
  `<option value="${H(value)}" ${value===key?'selected':''}>${H(C.monthLabel(value))}${state.months[value].status==='draft'?' · черновик':''}</option>`
 ).join('');
 const tabs=[['sheet','Ведомость'],['employees','Сотрудники'],['journal','Журнал'],['check','Контроль'],['backup','Резерв и экспорт']];
 return `<header class="topbar"><div class="brand"><div class="brand-logo" aria-hidden="true">И</div><div><div class="brand-title">ИГНИС ПРО</div><div class="brand-subtitle">Зарплата и кадры</div></div></div>
 <div class="top-actions"><span class="source-status ${localOk?'':'save-error'}">${localOk?'Шифрованное сохранение':'Ошибка автосохранения'}</span>${btn('Скачать Excel','export-xlsx','btn-ghost')}</div></header>
 <nav class="tabs" aria-label="Разделы приложения">${tabs.map(([id,label])=>`<button type="button" class="tab ${tab===id?'active':''}" ${tab===id?'aria-current="page"':''} data-tab="${id}">${label}</button>`).join('')}</nav>
 <div class="subtitle-bar"><div><div class="eyebrow">Расчётный период</div><h1 class="h1">${H(C.monthCaption(key))}</h1><div class="period-meta"><span>${H(date(period.start))} — ${H(date(period.end))}</span>${month.status==='source'?'<span class="chip chip-ok">Исходные данные</span>':'<span class="chip chip-warning">Черновик</span>'}</div></div>
 <div class="toolbar"><select aria-label="Выберите месяц" id="month-select">${options}</select>${nextButton()}</div></div>`;
}
function kpi(name,value,hint,cls='',valClass=''){return `<div class="kpi ${cls}"><div class="name">${name}</div><div class="value ${valClass}">${value}</div><div class="hint">${hint}</div></div>`;}
function summaryCards(){
 const t=C.calcTotals(state,state.activeMonth);
 return `<div class="cards">${kpi('К выдаче',C.money(t.due),'Итого за период','primary','green')}${kpi('Начислено',C.money(t.accrued),'С доплатами и премиями')}${kpi('Авансы и удержания',C.money(t.advance+t.fine+t.deduction+t.loanPayment),'Из них по займам '+C.money(t.loanPayment))}${kpi('Остаток по займам',C.money(t.debt),'На конец периода')}</div>`;
}
function renderSheet(){const t=C.calcTotals(state,state.activeMonth),data=C.calcRows(state,state.activeMonth);const cols=[['№','№'],['Сотрудник','Сотрудник'],['Смены','Смены'],['Ставка','Ставка за смену / месяц'],['Доп. ч.','Дополнительные часы'],['Опл. доп. ч.','Оплата дополнительных часов'],['Доплаты','Прочие доплаты'],['Премия','Премия'],['Начислено','Начислено'],['На карту','Зарплата на карту'],['Авансы','Авансы'],['Штрафы','Штрафы'],['Доп. удерж.','Дополнительные удержания'],['Платёж по займу','Платёж по займу'],['К выдаче','К выдаче'],['Долг','Остаток долга'],['Прошлый месяц','Начислено в предыдущем месяце'],['Примечание','Примечание']];
 let tbody='';const mobile=[];
 for(let i=0;i<data.length;i++){const r=data[i],em=r.emp,row=r.row;const numberOrDash=v=>v===null||v===undefined?'<span class="muted">—</span>':C.amount(v), d=r.overridden?`<span class="chip chip-manual" title="Значение установлено вручную">ручн.</span>`:'';
 const cc=(content,extra='')=>`<td ${extra}>${content}</td>`;
 tbody+=`<tr data-employee-search="${H(em.name.toLowerCase())}">`+
 cc(i+1)+cc(`<div class="stack"><button type="button" class="person-link" data-action="person-profile" data-id="${H(em.id)}">${H(em.name)}</button>${btn('✎','edit-row','table-action',`data-id="${H(em.id)}" aria-label="Редактировать расчёт: ${H(em.name)}"`)}</div>`,'class="employee-cell"')+
 cc(rowInput(em.id,'shifts',row.shifts,'','Смены'))+cc(rowInput(em.id,'rate',r.rate,'','Ставка'+(row.rateLinked?' (переносится)':'')))+cc(rowInput(em.id,'hours',row.hours,'','Доп. часы; прошлый месяц: '+(r.previousHours??'—')))+
 cc(numberOrDash(r.overtimePay),'class="noedit"')+cc(rowInput(em.id,'extras',row.extras))+cc(rowInput(em.id,'bonus',row.bonus))+cc(numberOrDash(r.accrued),'class="noedit"')+
 cc(rowInput(em.id,'card',row.card))+cc(numberOrDash(r.advance))+cc(numberOrDash(r.fine))+cc(numberOrDash(r.deduction))+cc(numberOrDash(r.loanPayment))+
 cc(`${numberOrDash(r.due)} ${d}`,`class="noedit ${r.due===0&&r.overridden?'no-pay':''}"`)+cc(numberOrDash(r.debt))+cc(numberOrDash(r.previousAccrued))+cc(rowInput(em.id,'note',row.note));
 tbody+='</tr>';
 mobile.push(`<article class="mobile-employee" data-employee-search="${H(em.name.toLowerCase())}"><div class="line"><div><button type="button" class="person-link name" data-action="person-profile" data-id="${H(em.id)}">${H(em.name)}</button><div class="small-muted">${H(em.payType)}</div></div>${r.overridden?'<span class="chip chip-manual">Исключение</span>':''}</div><div class="details"><div class="mini">Начислено<b>${numberOrDash(r.accrued)}</b></div><div class="mini">К выдаче<b>${numberOrDash(r.due)}</b></div><div class="mini">Смены / часы<b>${numberOrDash(r.shifts)} / ${numberOrDash(r.hours)}</b></div><div class="mini">Остаток долга<b>${numberOrDash(r.debt)}</b></div></div><div class="line"><div class="small-muted">Ставка ${C.money(r.rate)} · авансы ${C.money(r.advance)}</div>${btn('Редактировать','edit-row','btn-primary btn-sm',`data-id="${H(em.id)}"`)}</div></article>`);
 }
 const totalCols=[t.employees,'ИТОГО',t.shifts,'',t.hours,t.overtimePay,t.extras,t.bonus,t.accrued,t.card,t.advance,t.fine,t.deduction,t.loanPayment,t.due,t.debt,t.previousAccrued,''];
 const tfoot=`<tr>${totalCols.map((v,i)=>`<td>${i===1?v:(v===''?'':C.amount(v))}</td>`).join('')}</tr>`;
 const restoredWarn=state.months[state.activeMonth].status==='source'?'<div class="notice"><strong>Исходные исключения сохранены без автоматического исправления.</strong> Три ручных значения «К выдаче» и исходная логика долга остаются в силе. Даты операций и финансовые расхождения — во вкладке «Контроль».</div>':'<div class="notice"><strong>Новый месяц — черновик.</strong> Ставки, порядок расчётов, остатки займов и сведения прошлого месяца перенесены. Фактические смены, допчасы, выплаты на карту и премии не перенесены, чтобы не создать фиктивных начислений.</div>';
 return `${summaryCards()}<details class="period-details"><summary>Особенности расчёта за месяц</summary>${restoredWarn}</details><section class="panel searchable-panel"><div class="panel-head"><h2>Расчётная ведомость</h2><span class="chip">${t.employees} сотрудников</span><div class="tools"><input id="sheet-search" class="search" type="search" placeholder="Поиск по сотрудникам" aria-label="Поиск по сотрудникам" value="${H(lastSearch)}"/>${btn('Добавить сотрудника','add-employee','btn-secondary btn-sm')}${btn('Печать','print','btn-secondary btn-sm')}</div></div><div class="sheet-viewport desktop-sheet"><table class="sheet"><thead><tr>${cols.map(x=>`<th title="${H(x[1])}">${H(x[0])}</th>`).join('')}</tr></thead><tbody>${tbody}</tbody><tfoot>${tfoot}</tfoot></table></div><div class="mobile-cards">${mobile.join('')}</div><p class="no-results">Сотрудники не найдены</p></section>`;
}
function journalTypeOpt(type){return ['Аванс','Штраф','Дополнительное удержание','Удержание из зарплаты','Выдача займа','Возврат вне зарплаты','Начальный остаток','Долг организации (начальный)'].map(t=>`<option value="${H(t)}" ${t===type?'selected':''}>${H(t)}</option>`).join('');}
function employeeOptions(id){return state.employees.map(e=>`<option value="${H(e.id)}" ${e.id===id?'selected':''}>${H(e.name)}</option>`).join('');}
function renderJournal(){const ms=state.activeMonth,ops=state.operations.filter(x=>journalScope==='all'||x.month===ms),names=new Map(state.employees.map(x=>[x.id,x.name]));
 const rows=ops.map((o,i)=>`<tr><td class="narrow">${H(o.date?.split('-').reverse().join('.')||'')}</td><td>${H(names.get(o.employeeId)||'')}</td><td>${H(o.type)}</td><td class="num"><strong>${C.money(o.amount)}</strong></td><td class="narrow">${H(o.month)}</td><td>${H(o.note)}</td><td class="narrow">${btn('Изменить','edit-operation','btn-secondary btn-sm',`data-id="${H(o.id)}"`)} ${btn('Удалить','delete-operation','btn-secondary btn-sm',`data-id="${H(o.id)}"`)}</td></tr>`).join('');
 return `<section class="panel"><div class="panel-head"><h2>Журнал авансов, штрафов, займов и погашений</h2><span class="chip">${ops.length} записей</span><div class="tools">${btn('＋ Добавить операцию','add-operation','btn-primary btn-sm')}<select id="journal-scope"><option value="all" ${journalScope==='all'?'selected':''}>Все операции</option><option value="selected" ${journalScope==='selected'?'selected':''}>Только ${H(C.monthLabel(ms))}</option></select></div></div><div class="notice" style="margin:14px">Выдача займа увеличивает задолженность, но не уменьшает зарплату. Удержание из зарплаты уменьшает одновременно сумму к выдаче и задолженность. Исторические операции не удаляются при переходе месяца.</div><div class="table-clip"><table class="compact-table"><thead><tr><th>Дата</th><th>Сотрудник</th><th>Операция</th><th class="num">Сумма</th><th>В счёт</th><th>Основание / примечание</th><th>Действия</th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="empty">Пока операций нет</td></tr>'}</tbody></table></div></section>`;
}
function renderEmployees(){
 const cards=state.employees.map(employee=>{
  const id=H(employee.id), name=H(employee.name);
  const initials=employee.name.trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('');
  const photo=employee.profile?.photo;
  const avatar=typeof photo==='string' && photo.startsWith('data:image/jpeg;base64,')
   ? `<img src="${H(photo)}" alt="" loading="lazy" decoding="async">` : H(initials);
  const search=H([employee.name,employee.position].filter(Boolean).join(' ').toLowerCase());
  return `<article class="directory-row" data-employee-search="${search}">
   <button type="button" class="directory-person" data-action="person-profile" data-id="${id}">
    <span class="directory-avatar" aria-hidden="true">${avatar}</span>
    <span class="directory-identity"><strong>${name}</strong><small>${H(employee.position||employee.payType||'')}</small></span>
   </button><div class="directory-pay"><strong>${C.money(employee.rate)}</strong><small>${H(employee.payType||'')}</small></div>
   ${employee.archived?'<span class="chip chip-warning">Архив</span>':''}
   ${btn('Карточка','person-profile','btn-secondary btn-sm directory-open',`data-id="${id}" aria-label="Карточка: ${name}"`)}
  </article>`;
 }).join('');
 return `<section class="panel searchable-panel"><div class="panel-head"><h2>Сотрудники</h2><span class="chip">${state.employees.length}</span>
 <div class="tools"><input id="sheet-search" class="search" type="search" aria-label="Поиск по имени или должности" placeholder="Имя или должность" value="${H(lastSearch)}">
 ${btn('Добавить сотрудника','add-employee','btn-primary btn-sm')}</div></div>
 <div class="directory-list">${cards}</div><p class="no-results">Сотрудники не найдены</p></section>`;
}
function sourceAudit(){const k='2026-10',m=state.months[k];if(!m)return {matched:0,changed:0,differences:[]};let matched=0,changed=0;const differences=[];
 for(const e of state.employees){const raw=m.rows[e.id];if(!raw?.originalCache)continue;const x=C.calcRow(state,k,e);if(!x)continue;
 const matchVals={F:x.overtimePay,J:x.accrued,K:x.card,L:x.advance,M:x.fine,N:x.deduction,O:x.loanPayment,P:x.due,Q:x.debt};
 for(const [col,v] of Object.entries(matchVals)){
  const cached=raw.originalCache[col];if((v===null||v==='')&&(cached===null||cached==='')){matched++;continue;}
  if(col==='K'&&cached===null&&x.row.card===null&&v===0){matched++;continue;}
  if(v===cached){matched++;continue;}
  changed++;if(differences.length<15)differences.push(`${e.name} (${col}${raw.originalRow}): Excel ${cached??'пусто'}, сейчас ${v??'пусто'}`);
 }
 }return {matched,changed,differences};}
function renderCheck(){const k=state.activeMonth,total=C.calcTotals(state,k),issues=C.warnings(state,k),errs=C.validateState(state),v=sourceAudit();
 const options=issues.map(w=>`<div class="warning-item severity-${H(w.severity)}"><p><span class="icon">${w.severity==='warning'?'⚠':'ℹ'}</span>${H(w.text)}</p></div>`).join('');
 let ref='';if(state.months['2026-10']&&state.source?.baselineTotals){
 const oct=C.calcTotals(state,'2026-10'),b=state.source.baselineTotals;const comp=[['Начислено',b.J,oct.accrued],['К выдаче',b.P,oct.due],['Авансы',b.L,oct.advance],['Удержания из зарплаты',b.O,oct.loanPayment],['Долг',b.Q,oct.debt]];
 ref=`<div class="panel"><div class="panel-head"><h2>Сверка с исходным октябрьским Excel</h2></div><div class="content-pad"><div class="two-col"><div>${comp.map(([label,src,now])=>`<div class="statline"><span>${H(label)} · источник ${C.money(src)}</span><strong>${C.money(now)} ${Math.abs(src-now)<.01?'✓':'≠'}</strong></div>`).join('')}</div><div><p class="subdued">Сопоставлены расчётные ячейки F, J, K, L, M, N, O, P, Q на всех 23 строках исходной книги.</p><div class="success-line">${v.changed?`⚠ Изменены ${v.changed} значений от исходной версии`:`✓ Все ${v.matched} сверенных значений совпадают`}</div>${v.differences.map(x=>`<div class="small-muted">${H(x)}</div>`).join('')}<p class="footnote">После ваших правок отличия от исходника допустимы; это контроль изменений, а не признак ошибки.</p></div></div></div></div>`;
 }
 return `${ref}<div class="two-col"><section class="panel"><div class="panel-head"><h2>Проверка формул и исключений</h2><span class="chip ${issues.some(x=>x.severity==='warning')?'chip-warning':'chip-ok'}">${issues.length} замечаний</span></div><div class="content-pad">${errs.length?errs.map(e=>`<div class="warning-item severity-warning">${H(e)}</div>`).join(''):'<div class="success-line">✓ Структура данных и идентификаторы корректны</div>'}${options||'<div class="success-line">✓ Замечаний нет</div>'}</div></section><section class="panel"><div class="panel-head"><h2>Правила расчёта</h2></div><div class="content-pad"><div class="statline"><span>Дополнительный час</span><strong>Ставка / 10 (обычно)</strong></div><div class="statline"><span>Начислено</span><strong>Смены × ставка + доплаты + премия</strong></div><div class="statline"><span>К выдаче</span><strong>Начислено − карта − удержания</strong></div><div class="statline"><span>Полный долг по займам</span><strong>Не вычитается из зарплаты целиком</strong></div><div class="statline"><span>Расчётный месяц</span><strong>16-го — 15-го</strong></div><div class="statline"><span>Вручную не выдаётся</span><strong>${C.calcRows(state,"2026-10").filter(x=>x.overridden).length} исключения в октябре</strong></div>${state.months['2026-10']?.sourceSummaryNote?`<p class="notice"><strong>Примечание итоговой строки исходного Excel:</strong> ${H(state.months['2026-10'].sourceSummaryNote)}. Это справочная запись, не рассчитанный автоматически итог.</p>`:''}<p class="footnote">Особые режимы: фиксированный месячный оклад, расчёт от суммы на карту и запрет почасовых начислений применяются согласно индивидуальным настройкам сотрудников.</p></div></section></div>`;
}
function renderBackup(){const audit=(state.audit||[]).slice(0,12).map(a=>`<div class="audit-item"><time>${H(a.at.replace('T',' ').slice(0,19))}</time><div>${H(a.message)}</div></div>`).join('');return `<div class="two-col"><section class="panel"><div class="panel-head"><h2>Сохранение и экспорт</h2></div><div class="content-pad"><div class="secure-note"><strong>Данные зарплат конфиденциальны.</strong> Данные на устройстве шифруются AES-256-GCM.  JSON, Excel и CSV выгружаются без шифрования — храните их только в защищённом месте.</div><div class="form-buttons">${btn('Скачать полную резервную копию .json','export-json','btn-primary')}${btn('Ведомость Excel .xlsx','export-xlsx','btn-secondary')}${btn('Ведомость CSV','export-csv','btn-secondary')}${btn('Журнал CSV','export-ops-csv','btn-secondary')}</div>${window.IGNIS_PAYROLL_DEMO?'':`<h3 style="margin:26px 0 9px;font-size:14px">Восстановить из файла</h3><input type="file" accept="application/json,.json" id="import-json"/><p class="footnote">Импорт сначала проверяет формат файла. Перед заменой текущей базы программа предложит сохранить её копию.</p>`}</div></section><section class="panel"><div class="panel-head"><h2>Состояние и источник</h2></div><div class="content-pad"><div class="statline"><span>Месяцев</span><strong>${Object.keys(state.months).length}</strong></div><div class="statline"><span>Сотрудников</span><strong>${state.employees.length}</strong></div><div class="statline"><span>Операций</span><strong>${state.operations.length}</strong></div><div class="statline"><span>Автосохранение</span><strong>${localOk?'Шифруется на устройстве':'Ошибка сохранения'}</strong></div><div class="statline"><span>Источник</span><strong>${H(state.source?.name||'Ведомость на устройстве')}</strong></div><p class="small-muted">Контрольная сумма оригинала SHA-256:<br/><span class="monospace">${H(state.source?.sha256)}</span></p><div class="secure-note" style="margin-top:16px">Для восстановления используйте зашифрованную резервную копию. Сброс базы отключён, чтобы избежать случайной потери данных.</div></div></section></div><section class="panel"><div class="panel-head"><h2>Журнал изменений в приложении</h2></div><div class="content-pad">${audit||'<span class="small-muted">Изменений пока нет</span>'}</div></section>`;}
function render(){renderCount++;const html=renderHeader()+(tab==='sheet'?renderSheet():tab==='journal'?renderJournal():tab==='employees'?renderEmployees():tab==='check'?renderCheck():renderBackup());
 by('app').innerHTML=html;const search=by('sheet-search');if(search)filterSheet(lastSearch);
}
function filterSheet(str){lastSearch=str.toLowerCase().trim();document.querySelectorAll('[data-employee-search]').forEach(el=>{el.classList.toggle('hidden',!el.dataset.employeeSearch.includes(lastSearch));});}
function modal(html,title){by('modal-root').innerHTML=`<div class="modal-backdrop" id="modal-backdrop"><div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>${H(title)}</h2>${btn('Закрыть','close-modal','btn-secondary btn-sm')}</div><div class="modal-body">${html}</div></div></div>`;}
function closeModal(){by('modal-root').innerHTML='';}
const formField=(label,id,value,type='text',cols=1,extra='')=>`<label class="field ${cols>1?'cols'+cols:''}"><span>${H(label)}</span><input name="${H(id)}" type="${type}" value="${H(value??'')}" ${type==='number'?'step="any" inputmode="decimal"':'autocomplete="off"'} ${extra}/></label>`;
function showRow(id){const emp=state.employees.find(e=>e.id===id),r=state.months[state.activeMonth].rows[id];if(!emp||!r)return;
 const initial=C.calcRow(state,state.activeMonth,emp),dueText=initial?.due===null?'не рассчитано':C.money(initial.due);
 modal(`<form id="edit-row-form" data-id="${H(id)}"><div class="form-grid">${formField('Смены','shifts',r.shifts,'number')}${formField('Ставка, ₽','rate',initial.rate,'number')}${formField('Доп. часы','hours',r.hours,'number')}${formField('Делитель почасовой ставки','overtimeDivisor',r.overtimeDivisor||10,'number')}${formField('Прочие доплаты, ₽','extras',r.extras,'number')}${formField('Премия, ₽','bonus',r.bonus,'number')}${formField('На карту, ₽','card',r.card,'number')}${formField('Пред. месяц, начислено, ₽','previousAccrued',initial.previousAccrued,'number')}<label class="field cols2"><span>Способ начисления</span><select name="accruedMode"><option value="shift" ${r.accruedMode==='shift'?'selected':''}>Посменно</option><option value="monthly" ${r.accruedMode==='monthly'?'selected':''}>Месячный оклад</option><option value="card" ${r.accruedMode==='card'?'selected':''}>От суммы на карту</option></select></label><label class="field cols2"><span>Почасовая оплата</span><label class="checkbox-line"><input type="checkbox" name="overtimeDisabled" ${r.overtimeDisabled?'checked':''}/> Отключена (0 ₽ за доп. часы)</label></label><label class="field cols2"><span>Исключение «К выдаче»</span><label class="checkbox-line"><input id="manualDueCheck" type="checkbox" name="manualDue" ${r.dueOverride!==null?'checked':''}/> Вручную зафиксированная сумма</label></label>${formField('К выдаче вручную, ₽','dueOverride',r.dueOverride,'number',2)}<label class="field cols6"><span>Примечание</span><textarea rows="3" name="note" maxlength="1000">${H(r.note||'')}</textarea></label></div><p class="footnote">Дополнительные часы предыдущего месяца: ${initial.previousHours??'—'}. ${r.rateLinked?'Ставка связана с предыдущим месяцем. ':''}${r.previousAccruedLinked?'Прошлые начисления связаны с предыдущим месяцем. ':''}При изменении ставки/прошлых начислений вручную связь прерывается.</p><p class="footnote">Авансы, штрафы, займы и удержания редактируются только в журнале. Сейчас «К выдаче»: <strong>${dueText}</strong>. Ручные нулевые значения из исходника защищены от автоматического сброса.</p><div class="form-buttons"><button type="submit" class="btn btn-primary">Сохранить карточку месяца</button>${btn('Отмена','close-modal')}</div></form>`,`Расчёт: ${emp.name}`);
}
function showOperation(id){const o=id?state.operations.find(op=>op.id===id):null,p=C.monthlyPeriod(state.activeMonth);
 const html=`<form id="operation-form" data-id="${H(o?.id||'')}"><div class="form-grid">${formField('Дата операции','date',o?.date||p.end,'date',2)}<label class="field cols2"><span>Сотрудник</span><select name="employeeId">${employeeOptions(o?.employeeId||state.employees[0]?.id)}</select></label><label class="field cols2"><span>Тип операции</span><select name="type">${journalTypeOpt(o?.type||'Аванс')}</select></label>${formField('Сумма, ₽','amount',o?.amount,'number',2,'required min="0"')}${formField('В счёт месяца','month',o?.month||state.activeMonth,'month',2,'required')}<label class="field cols6"><span>Основание / примечание</span><textarea rows="3" name="note">${H(o?.note||'')}</textarea></label></div><div class="form-buttons"><button class="btn btn-primary" type="submit">${o?'Сохранить изменения':'Добавить операцию'}</button>${btn('Отмена','close-modal')}</div></form>`;
 modal(html,o?'Редактирование операции':'Новая операция');
}
function showEmployee(id){const e=id?state.employees.find(x=>x.id===id):null;modal(`<form id="employee-form" data-id="${H(e?.id||'')}"><div class="form-grid">${formField('ФИО','name',e?.name,'text',3,'required')}${formField('Должность','position',e?.position,'text',3)}<label class="field cols2"><span>Тип оплаты</span><select name="payType">${['Посменно','Оклад в месяц','Только карта','Посменно · выдача не ежемесячно'].map(t=>`<option ${e?.payType===t?'selected':''}>${H(t)}</option>`).join('')}</select></label>${formField('Ставка, ₽','rate',e?.rate,'number',2,'required min="0"')}${formField('2-я ставка, ₽','secondRate',e?.secondRate,'number',2)}${formField('Телефон','phone',e?.phone,'tel',2)}${formField('Гражданство','citizenship',e?.citizenship,'text',2)}${formField('Дата рождения','dob',e?.dob,'date',2)}${formField('Принят','joined',e?.joined,'date',2)}${formField('Карта / банк','bank',e?.bank,'text',2)}${formField('Документы','documents',e?.documents,'text',3)}<label class="field cols6"><span>Заметки</span><textarea name="notes" rows="4">${H(e?.notes||'')}</textarea></label><label class="field cols3"><span>Статус</span><label class="checkbox-line"><input type="checkbox" name="archived" ${e?.archived?'checked':''}/> Архивный (новые месяцы не открывать)</label></label></div><div class="form-buttons"><button type="submit" class="btn btn-primary">Сохранить сотрудника</button>${btn('Отмена','close-modal')}</div></form>`,e?'Карточка сотрудника':'Новый сотрудник');}
function valueFromForm(form,field){const inp=form.elements.namedItem(field);return inp&&inp.value!==''?inp.value:null;}
function numericForm(form,field){const v=valueFromForm(form,field);if(v===null)return null;return C.number(v);}
function toCSV(rows){function csvCell(v){let s=v===null||v===undefined?'':String(v);if(/^[=+@\t\r]/.test(s)||/^-[^\d]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}return '\ufeff'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');}
function exportCSV(mode){let rows=[];if(mode==='sheet'){
 rows=[['№','Сотрудник','Смены','Ставка','Доп. часы','Оплата доп. часов','Доплаты','Премия','Начислено','ЗП на карту','Авансы','Штрафы','Доп. удержания','Платёж по займу','К выдаче','Остаток долга','Пред. месяц начислено','Примечание']];
 for(const [i,r] of C.calcRows(state,state.activeMonth).entries())rows.push([i+1,r.emp.name,r.shifts,r.rate,r.row.hours,r.overtimePay,r.row.extras,r.row.bonus,r.accrued,r.card,r.advance,r.fine,r.deduction,r.loanPayment,r.due,r.debt,r.previousAccrued,r.row.note]);
 const t=C.calcTotals(state,state.activeMonth);rows.push(['','ИТОГО',t.shifts,'',t.hours,t.overtimePay,t.extras,t.bonus,t.accrued,t.card,t.advance,t.fine,t.deduction,t.loanPayment,t.due,t.debt,t.previousAccrued,'']);
 }else{const names=new Map(state.employees.map(e=>[e.id,e.name]));rows=[['Дата','Сотрудник','Тип операции','Сумма, ₽','В счёт месяца','Примечание']];for(const o of state.operations)rows.push([o.date,names.get(o.employeeId)||'',o.type,o.amount,o.month,o.note]);}
 download((mode==='sheet'?prefix():'ЗП_Журнал_все_операции')+'.csv',new Blob([toCSV(rows)],{type:'text/csv;charset=utf-8'}));toast('CSV подготовлен к скачиванию');}
function openPersonProfile(id){
 const employee=state.employees.find(person=>person.id===id);
 if(!employee)return;
 const session=state;
 const activeRow=state.months[state.activeMonth].rows[id];
 const result=activeRow ? C.calcRow(state,state.activeMonth,employee) : null;
 const summary=result ? C.monthCaption(state.activeMonth) : '';
 const payItems=result ? [
  ['Смены', result.shifts===null?'—':C.amount(result.shifts)], ['Ставка', C.money(result.rate)],
  ['Начислено', result.accrued===null?'—':C.money(result.accrued)], ['Переведено на карту', C.money(result.card)],
  ['Авансы', C.money(result.advance)], ['К выдаче', result.due===null?'—':C.money(result.due)]
 ] : [];
 window.PersonProfile.open({employee,summary,payItems,editInfo:()=>showEmployee(id),anchor:document.activeElement,commit:async profile=>{
  if(session!==state)throw Error('Откройте карточку повторно.');
  const snapshot=C.copy(state);
  snapshot.employees.find(person=>person.id===id).profile=profile;
  await window.PayrollVault.persist(snapshot);
  if(session!==state)return;
  employee.profile=profile;
  localOk=true;
  render();
 }});
}
function onAction(action,id){
 if(action==='person-profile'){openPersonProfile(id);return;}
 if(action==='close-modal'){closeModal();return;}
 if(action==='print'){window.print();return;}
 if(action==='export-json'){if(!confirm('JSON не зашифрован. Продолжить скачивание конфиденциальной базы?'))return;jsonFile('ЗП_РЕЗЕРВ_'+new Date().toISOString().slice(0,10)+'.json',state);toast('Полная резервная копия подготовлена');return;}
 if(action==='export-csv'||action==='export-ops-csv'){if(!confirm('CSV не зашифрован. Продолжить экспорт?'))return;exportCSV(action==='export-csv'?'sheet':'ops');return;}
 if(action==='export-xlsx'){if(!confirm('Excel не зашифрован. Продолжить выгрузку?'))return;try{download('ЗП_Восстановленная_'+state.activeMonth+'.xlsx',Excel.workbook(state));toast('Excel с формулами и журналом подготовлен');}catch(e){console.error(e);toast('Ошибка выгрузки Excel: '+e.message,'error');}return;}
 if(action==='next-month'){
  const k=C.nextMonth(state.activeMonth);if(state.months[k]){state.activeMonth=k;save();render();return;}
  if(!confirm(`Создать ${C.monthLabel(k)}? Ставки и долг перейдут, но фактические отработанные часы и выплаты не будут скопированы.`))return;
  C.makeMonth(state,state.activeMonth);for(const e of state.employees){if(e.archived)delete state.months[k].rows[e.id];}audit('Создан черновик '+C.monthLabel(k));save();render();toast('Создан новый месяц');return;
 }
 if(action==='edit-row'){showRow(id);return;}
 if(action==='edit-employee'||action==='add-employee'){showEmployee(action==='edit-employee'?id:null);return;}
 if(action==='edit-operation'||action==='add-operation'){showOperation(action==='edit-operation'?id:null);return;}
 if(action==='delete-operation'){
  const o=state.operations.find(q=>q.id===id);if(!o)return;
  if(!confirm(`Удалить операцию ${C.money(o.amount)} (${o.type})? Это изменит начисление и/или задолженность. Сделайте резервную копию перед удалением.`))return;
  audit('Удалена операция '+id+' '+o.type+' на '+C.money(o.amount));state.operations=state.operations.filter(q=>q.id!==id);save();render();toast('Операция удалена');return;
 }

}
document.addEventListener('click',e=>{const bt=e.target.closest('[data-action]');if(bt){e.preventDefault();onAction(bt.dataset.action,bt.dataset.id);}const t=e.target.closest('[data-tab]');if(t){tab=t.dataset.tab;lastSearch='';render();}if(e.target.id==='modal-backdrop')closeModal();});
document.addEventListener('change',e=>{
 if(e.target.id==='month-select'){state.activeMonth=e.target.value;save();render();return;}
 if(e.target.id==='journal-scope'){journalScope=e.target.value;render();return;}
 if(e.target.matches('[data-scope="row"]')){
  const f=e.target.dataset.field,id=e.target.dataset.id,row=state.months[state.activeMonth]?.rows[id];if(!row)return;
  const val=f==='note'?e.target.value:(e.target.value===''?null:C.number(e.target.value));if(f!=='note'&&val!==null&&val<0){toast('Отрицательные значения вводите только через корректирующую операцию','error');render();return;}
  if(row[f]===val&&!row.rateLinked)return;row[f]=val;if(f==='rate')row.rateLinked=false;
  audit(`Изменено поле ${f} (${state.employees.find(x=>x.id===id)?.name||id}, ${state.activeMonth})`);save();render();return;
 }
 if(e.target.id==='import-json'){
  const file=e.target.files?.[0];if(!file)return;
  const reader=new FileReader();reader.onload=()=>{try{const incoming=JSON.parse(reader.result),errors=C.validateState(incoming);if(errors.length)throw Error(errors.slice(0,3).join('; '));
  if(!confirm(`Заменить текущую базу на файл ${file.name}? В текущей базе ${state.employees.length} сотрудников и ${state.operations.length} операций.`))return;
  window.PayrollVault.downloadEncrypted();state=incoming;audit('Восстановлена база из файла '+file.name);save();render();toast('Резервная копия восстановлена');
  }catch(err){toast('Ошибка импорта: '+err.message,'error');}};reader.readAsText(file);
 }
});
document.addEventListener('input',e=>{if(e.target.id==='sheet-search'){filterSheet(e.target.value);}});
document.addEventListener('submit',e=>{
 const form=e.target;if(!['edit-row-form','operation-form','employee-form'].includes(form.id))return;e.preventDefault();
 if(form.id==='edit-row-form'){
  const id=form.dataset.id,r=state.months[state.activeMonth].rows[id];const fields=['shifts','rate','hours','overtimeDivisor','extras','bonus','card','previousAccrued'];
  for(const f of fields){const v=numericForm(form,f);if(v!==null&&v<0){toast('Отрицательные начисления и ставки не допускаются','error');return;}if(f==='overtimeDivisor'&&(v===null||v<=0)){toast('Делитель должен быть больше нуля','error');return;}}
  for(const f of fields){const val=numericForm(form,f);if(f==='rate'&&r.rateLinked&&val===C.number(C.calcRow(state,state.activeMonth,state.employees.find(e=>e.id===id)).rate)){continue;}if(f==='previousAccrued'&&r.previousAccruedLinked&&val===C.number(C.calcRow(state,state.activeMonth,state.employees.find(e=>e.id===id)).previousAccrued)){continue;}r[f]=val;if(f==='rate')r.rateLinked=false;if(f==='previousAccrued')r.previousAccruedLinked=false;}r.accruedMode=form.elements.namedItem('accruedMode').value;r.overtimeDisabled=form.elements.namedItem('overtimeDisabled').checked;r.dueOverride=form.elements.namedItem('manualDue').checked?numericForm(form,'dueOverride'):null;
  if(form.elements.namedItem('manualDue').checked&&r.dueOverride===null){toast('Для ручного расчёта нужна числовая сумма','error');return;}
  r.note=form.elements.namedItem('note').value;
  audit('Изменены параметры начисления для '+state.employees.find(e=>e.id===id)?.name+' ('+state.activeMonth+')');save();closeModal();render();toast('Расчёт обновлён');return;
 }
 if(form.id==='operation-form'){
  const amt=numericForm(form,'amount'),date=valueFromForm(form,'date'),month=valueFromForm(form,'month'),empId=valueFromForm(form,'employeeId');
  if(amt===null||amt<0||!date||!month||!empId){toast('Проверьте дату, сумму, сотрудника и месяц','error');return;}
  const id=form.dataset.id,op=id?state.operations.find(o=>o.id===id):null;
  const dest=op||{id:'user-'+Date.now()+'-'+Math.floor(Math.random()*1000)};
  Object.assign(dest,{date,employeeId:empId,type:valueFromForm(form,'type'),amount:amt,month,note:valueFromForm(form,'note')||''});
  if(!op)state.operations.push(dest);
  audit((op?'Исправлена':'Добавлена')+' операция '+dest.type+', '+C.money(amt)+' ('+dest.month+')');save();closeModal();render();toast('Операция сохранена');return;
 }
 if(form.id==='employee-form'){
  const name=(valueFromForm(form,'name')||'').trim(),rate=numericForm(form,'rate');if(!name||rate===null||rate<0){toast('Проверьте ФИО и ставку','error');return;}
  const id=form.dataset.id,old=state.employees.find(x=>x.id===id);
  if(state.employees.some(e=>e.name.toLowerCase()===name.toLowerCase()&&e.id!==id)){toast('Такой сотрудник уже существует','error');return;}
  const obj=old||{id:'new-'+Date.now()};Object.assign(obj,{name,position:valueFromForm(form,'position')||'',payType:valueFromForm(form,'payType')||'Посменно',rate,secondRate:numericForm(form,'secondRate'),phone:valueFromForm(form,'phone')||'',citizenship:valueFromForm(form,'citizenship')||'',dob:valueFromForm(form,'dob'),joined:valueFromForm(form,'joined'),bank:valueFromForm(form,'bank')||'',documents:valueFromForm(form,'documents')||'',notes:valueFromForm(form,'notes')||'',archived:form.elements.namedItem('archived').checked});
  if(!old){state.employees.push(obj);for(const mo of Object.values(state.months))mo.rows[obj.id]={shifts:null,rate:obj.rate,hours:null,overtimeDisabled:false,overtimeDivisor:10,extras:null,bonus:null,card:null,accruedMode:obj.payType==='Оклад в месяц'?'monthly':obj.payType==='Только карта'?'card':'shift',dueOverride:null,previousAccrued:null,previousHours:null,note:'',originalCache:null};}
  audit((old?'Обновлена карточка':'Добавлен сотрудник')+' '+name);save();closeModal();render();toast('Карточка сотрудника сохранена');return;
 }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog.person-panel[open]'))closeModal();});
window.PayrollUI={
 start(initial){const errors=C.validateState(initial);if(errors.length)throw Error(errors.join('; '));state=C.copy(initial);tab='sheet';journalScope='all';lastSearch='';localOk=true;render();},
 close(){state=null;by('app').textContent='';by('modal-root').textContent='';},
};
})();
