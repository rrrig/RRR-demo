/* Зарплатная ведомость: расчётное ядро без внешних зависимостей.
   Все суммы в рублях. Excel октября 2026 г. — первоисточник исходных значений. */
(function(root){
'use strict';
const LOAN_TYPES=['Начальный остаток','Выдача займа','Удержание из зарплаты','Возврат вне зарплаты'];
const CURRENT_TYPES={advance:'Аванс',fine:'Штраф',deduction:'Дополнительное удержание',loanPayment:'Удержание из зарплаты'};
const MONTHS_RU=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
function number(v){if(v===null||v===undefined||v===''||v==='—') return null; const x=Number(v);return Number.isFinite(x)?x:null;}
function n(v){return number(v)??0;}
function money(v){return new Intl.NumberFormat('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:2}).format(n(v))+' ₽';}
function amount(v){return new Intl.NumberFormat('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:2}).format(n(v));}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function monthLabel(k){const [y,m]=String(k).split('-').map(Number);return (MONTHS_RU[m-1]||'месяц')+' '+y;}
function monthCaption(k){const [y,m]=String(k).split('-').map(Number);return (MONTHS_RU[m-1]||'Месяц').toLocaleUpperCase('ru-RU')+' '+y;}
function nextMonth(k){const [y,m]=k.split('-').map(Number);const d=new Date(Date.UTC(y,m,1));return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
function prevMonth(k){const [y,m]=k.split('-').map(Number);const d=new Date(Date.UTC(y,m-2,1));return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
function monthlyPeriod(k){const [y,m]=k.split('-').map(Number),next=nextMonth(k);return {start:k+'-16',end:next+'-15'};}
function monthOperations(state,k){return (state.operations||[]).filter(op=>op.month===k);}
function employeeOperations(state,id){return (state.operations||[]).filter(op=>op.employeeId===id);}
function loanDebt(state,empId,month){
 const cutoff=month?monthlyPeriod(month).end:null;
 const all=employeeOperations(state,empId).filter(op=>LOAN_TYPES.includes(op.type)&&(!cutoff || (op.date||'')<=cutoff));
 if(!all.length) return null;
 return all.reduce((s,op)=>s+(['Начальный остаток','Выдача займа'].includes(op.type)?n(op.amount):-n(op.amount)),0);
}
function journalForMonth(state,empId,month){
 const mine=employeeOperations(state,empId).filter(op=>op.month===month);
 const out={advance:0,fine:0,deduction:0,loanPayment:0};
 for(const op of mine){for(const [field,t] of Object.entries(CURRENT_TYPES))if(op.type===t) out[field]+=n(op.amount);}
 return out;
}
function calcRow(state,month,emp){
 const row=state.months?.[month]?.rows?.[emp.id]; if(!row)return null;
 const priorMonth=prevMonth(month);const linked=(row.rateLinked||row.previousAccruedLinked||row.previousHoursLinked)&&state.months?.[priorMonth]?calcRow(state,priorMonth,emp):null;
 const rate=number((row.rateLinked&&linked?linked.rate:row.rate)??emp.rate),shifts=number(row.shifts),hours=n(row.hours),divisor=(number(row.overtimeDivisor)??n(state.settings?.defaultOvertimeDivisor))||10;
 const overtimePay=row.overtimeDisabled?0:(rate===null?0:Math.round(hours*rate/divisor*100)/100);
 let accrued=null;
 if(row.accruedMode==='card') accrued=n(row.card)+overtimePay+n(row.extras)+n(row.bonus);
 else if(row.accruedMode==='monthly' && rate!==null) accrued=rate+overtimePay+n(row.extras)+n(row.bonus);
 else if(row.accruedMode==='shift' && shifts!==null && rate!==null) accrued=shifts*rate+overtimePay+n(row.extras)+n(row.bonus);
 const j=journalForMonth(state,emp.id,month),card=n(row.card);
 const expectedDue=accrued===null?null:accrued-card-j.advance-j.fine-j.deduction-j.loanPayment;
 const overridden=number(row.dueOverride)!==null;
 const due=overridden?number(row.dueOverride):expectedDue;
 const debt=loanDebt(state,emp.id,month);
 return {emp,row,rate,shifts,hours,overtimePay,accrued,card,...j,expectedDue,due,overridden,debt,previousAccrued:row.previousAccruedLinked&&linked?linked.accrued:row.previousAccrued,previousHours:row.previousHoursLinked&&linked?linked.row.hours:row.previousHours};
}
function calcRows(state,month){return(state.employees||[]).map(e=>calcRow(state,month,e)).filter(Boolean);}
function calcTotals(state,month){
 const rs=calcRows(state,month),out={employees:rs.length,shifts:0,hours:0,overtimePay:0,extras:0,bonus:0,accrued:0,card:0,advance:0,fine:0,deduction:0,loanPayment:0,due:0,debt:0,previousAccrued:0,heldUnpaid:0};
 for(const x of rs){for(const k of ['shifts','hours','overtimePay','accrued','card','advance','fine','deduction','loanPayment','due','debt','previousAccrued'])out[k]+=n(x[k]);out.extras+=n(x.row.extras);out.bonus+=n(x.row.bonus);if(x.overridden&&x.expectedDue!==null)out.heldUnpaid+=x.expectedDue-x.due;}
 return out;
}
function copy(obj){return JSON.parse(JSON.stringify(obj));}
function makeMonth(state,sourceMonth){
 const target=nextMonth(sourceMonth); if(state.months[target]) return target;
 const old=state.months[sourceMonth]; if(!old)throw Error('Предыдущий месяц отсутствует');
 const rows={};
 for(const emp of state.employees){const p=old.rows[emp.id]||{};const c=calcRow(state,sourceMonth,emp);
 rows[emp.id]={shifts:null,rate:c?c.rate:number(p.rate??emp.rate),rateLinked:true,hours:null,overtimeDisabled:!!p.overtimeDisabled,overtimeDivisor:number(p.overtimeDivisor)||10,extras:null,bonus:null,card:null,accruedMode:p.accruedMode||'shift',dueOverride:null,previousAccrued:c?c.accrued:null,previousAccruedLinked:true,previousHours:number(p.hours),previousHoursLinked:true,note:'',originalRow:null,originalCache:null,sourceFormulas:null};}
 state.months[target]={status:'draft',period:monthlyPeriod(target).start+' — '+monthlyPeriod(target).end,rows};
 state.activeMonth=target;
 return target;
}
function validateState(s){
 const errors=[];
 if(!s||s.schemaVersion!==1||!Array.isArray(s.employees)||!Array.isArray(s.operations)||!s.months||typeof s.months!=='object')errors.push('Неверный формат резервной копии');
 if(errors.length)return errors;
 const ids=new Set(),names=new Set();
 for(const e of s.employees){if(!e.id||!e.name)errors.push('Пустая карточка сотрудника');if(ids.has(e.id))errors.push('Повторный ID '+e.id);ids.add(e.id);if(names.has(e.name))errors.push('Повторное ФИО: '+e.name);names.add(e.name);if(number(e.rate)!==null&&n(e.rate)<0)errors.push('Отрицательная ставка '+e.name);}
 for(const op of s.operations){if(!ids.has(op.employeeId))errors.push('Неизвестный сотрудник в журнале: '+op.employeeId);if(!/\d{4}-\d{2}-\d{2}/.test(op.date||''))errors.push('Неверная дата операции: '+op.id);if(!/\d{4}-\d{2}/.test(op.month||''))errors.push('Неверный расчетный месяц: '+op.id);if(number(op.amount)===null||n(op.amount)<0)errors.push('Неверная сумма операции: '+op.id);}
 for(const [k,mo] of Object.entries(s.months)){if(!/\d{4}-\d{2}/.test(k))errors.push('Неверный месяц '+k);for(const id of Object.keys(mo.rows||{}))if(!ids.has(id))errors.push('Неизвестный сотрудник в '+k+': '+id);}
 if(!s.months[s.activeMonth]) errors.push('Активный месяц отсутствует');
 return errors;
}
function warnings(s,month){const list=[];
 for(const x of calcRows(s,month)){
  if(x.overridden&&x.expectedDue!==x.due)list.push({kind:'override',severity:'info',empId:x.emp.id,text:`${x.emp.name}: вручную установлено к выдаче ${money(x.due)}; по общей формуле ${money(x.expectedDue)}. Исключение сохранено.`});
  if(x.debt!==null&&x.debt<0)list.push({kind:'negativeDebt',severity:'warning',empId:x.emp.id,text:`${x.emp.name}: отрицательный остаток долга ${money(x.debt)} — проверьте операции.`});
  if(x.expectedDue!==null&&x.expectedDue<0)list.push({kind:'negativeDue',severity:'warning',empId:x.emp.id,text:`${x.emp.name}: расчётное «к выдаче» ${money(x.expectedDue)} меньше нуля.`});
 }
 const ignored=s.operations.filter(o=>o.type==='Долг организации (начальный)');
 if(ignored.length)list.push({kind:'originalDebtOmission',severity:'warning',text:`${ignored.length} операции «Долг организации (начальный)» на ${money(ignored.reduce((a,x)=>a+n(x.amount),0))} не входят в формулу долга исходного Excel. Не включены автоматически, требуется бухгалтерская сверка.`});
 for(const initial of s.operations.filter(o=>o.type==='Начальный остаток')){
   const match=String(initial.note||'').match(/\d[\d\s\u00a0]{4,}\d/);
   const said=match?number(match[0].replace(/[\s\u00a0]/g,'')):null;
   if(said!==null&&said!==n(initial.amount))list.push({kind:'initialBalanceMismatch',severity:'warning',text:`В операции ${initial.id} в графе суммы ${money(initial.amount)}, а в примечании ${money(said)}. Не исправлено автоматически.`});
 }
 for(const op of s.operations.filter(o=>o.month===month)){
  const period=monthlyPeriod(month); if(op.date<period.start||op.date>period.end)list.push({kind:'dateMismatch',severity:'info',text:`Операция ${op.id} (${op.date}) относится к ${month}, но дата вне стандартного периода 16–15. Проверьте принадлежность месяца.`});
 }
 return list;
}
const api={number,n,money,amount,escapeHtml,monthLabel,monthCaption,nextMonth,prevMonth,monthlyPeriod,monthOperations,employeeOperations,loanDebt,journalForMonth,calcRow,calcRows,calcTotals,copy,makeMonth,validateState,warnings,LOAN_TYPES,CURRENT_TYPES};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.PayrollCore=api;
})(typeof window!=='undefined'?window:globalThis);
