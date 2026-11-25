/* Простой независимый экспортер Excel .xlsx (OOXML + ZIP STORE, без сети).
   Значения и формулы формируются из одного расчётного ядра. */
(function(root){
'use strict';
const C=root.PayrollCore;
function esc(v){return String(v??'').replace(/[<>&"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
function xn(ref,value,style=0,formula=null){
 const s=style?` s="${style}"`:'';
 if(formula!==null){const valid=typeof value==='number'&&Number.isFinite(value);return `<c r="${ref}"${s}${valid?'':' t="str"'}><f>${esc(formula.replace(/^=/,''))}</f><v>${valid?value:''}</v></c>`;}
 if(value===null||value===undefined||value==='')return '';
 if(typeof value==='number'&&Number.isFinite(value))return `<c r="${ref}"${s}><v>${value}</v></c>`;
 return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}
function rowXml(i,cells){return `<row r="${i}">${cells.join('')}</row>`;}
function colWidth(list){return `<cols>${list.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;}
function docSheet(rows,widths,merged=null,freeze='C4'){
 const xf=freeze==='C4'?`<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="3" topLeftCell="C4" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="C4" sqref="C4"/></sheetView></sheetViews>`:'<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
 return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${xf}<sheetFormatPr defaultRowHeight="15"/>${colWidth(widths)}<sheetData>${rows.join('')}</sheetData>${merged?`<mergeCells count="1"><mergeCell ref="${merged}"/></mergeCells>`:''}<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.1" footer="0.1"/><pageSetup orientation="landscape" paperSize="8"/></worksheet>`;
}
function xref(n){let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
function jsDateSerial(v){if(!v)return null;const ms=Date.parse(v+'T00:00:00Z');return Number.isFinite(ms)?(ms-Date.UTC(1899,11,30))/86400000:null;}
const FIELDS=['№','Сотрудник','Смены','Ставка, ₽','Доп. часы','Оплата доп. часов','Прочие доплаты','Премия','','Начислено','ЗП на карту','Авансы','Штрафы','Доп. удержания','Платёж по займу','К выдаче','Остаток долга','Пред. месяц начислено','Примечание','Пред. мес. доп. часы'];
function SUMIFS(type,r,key){return `SUMIFS('Журнал'!$D$2:$D$250,'Журнал'!$B$2:$B$250,$B${r},'Журнал'!$C$2:$C$250,"${type}",'Журнал'!$E$2:$E$250,\"${key}\")`;}
function linkedFormula(state,key,column,row){const prev=C.prevMonth(key);if(!state.months[prev])return null;const prevName='ЗП '+prev.slice(5)+'-'+prev.slice(0,4);return `SUMIF('${prevName}'!$B$4:$B$200,B${row},'${prevName}'!$${column}$4:$${column}$200)`;}
function buildMonthSheet(state,key){
 const out=[],month=state.months[key],rs=C.calcRows(state,key);const period=C.monthlyPeriod(key);
 out.push(rowXml(1,[xn('A1','ЗАРПЛАТА · '+C.monthCaption(key),1)]));
 out.push(rowXml(2,[xn('A2',`Расчётный период ${period.start} — ${period.end} · Выгрузка из восстановленного приложения. Ячейки P с исключениями оставлены вручную.`)]));
 out.push(rowXml(3,FIELDS.map((v,i)=>xn(xref(i+1)+'3',v,2))));
 rs.forEach((r,i)=>{
   const row=i+4,a=[];const add=(col,val,style=3,formula=null)=>a.push(xn(col+row,val,style,formula));
   add('A',i+1,0);add('B',r.emp.name,0);add('C',r.shifts,0);add('D',r.rate,3,r.row.rateLinked?linkedFormula(state,key,'D',row):null);
   add('E',r.row.hours,0);
   const fof=r.row.overtimeDisabled?`N(E${row})*0`:`IF(AND(ISNUMBER(D${row}),ISNUMBER(C${row})),N(E${row})*D${row}/${C.n(r.row.overtimeDivisor)||10},"")`;
   add('F',r.overtimePay,3,fof);add('G',r.row.extras);add('H',r.row.bonus);
   const jf=r.row.accruedMode==='card'?`SUM(K${row},F${row},G${row},H${row})`:r.row.accruedMode==='monthly'?`IF(ISNUMBER(D${row}),D${row}+SUM(F${row}:H${row}),"")`:`IF(AND(ISNUMBER(C${row}),ISNUMBER(D${row})),C${row}*D${row}+SUM(F${row}:H${row}),"")`;
   add('J',r.accrued,3,jf);add('K',r.row.card);
   add('L',r.advance,3,SUMIFS('Аванс',row,key));add('M',r.fine,3,SUMIFS('Штраф',row,key));add('N',r.deduction,3,SUMIFS('Дополнительное удержание',row,key));add('O',r.loanPayment,3,SUMIFS('Удержание из зарплаты',row,key));
   add('P',r.due,3,r.overridden?null:`IF(ISNUMBER(J${row}),J${row}-SUM(K${row}:O${row}),"")`);
   const range='\'Журнал\'!$D$2:$D$250',p='\'Журнал\'!$B$2:$B$250',t='\'Журнал\'!$C$2:$C$250',dt='\'Журнал\'!$A$2:$A$250';
   const cutoff=`DATE(${Number(key.slice(0,4))},${Number(key.slice(5,7))+1},15)`;
   const sum=(type)=>`SUMIFS(${range},${p},$B${row},${t},"${type}",${dt},"<="&${cutoff})`;
   const count=(type)=>`COUNTIFS(${p},$B${row},${t},"${type}",${dt},"<="&${cutoff})`;
   const qformula=`IF(${C.LOAN_TYPES.map(count).join('+')}=0,"",${sum('Начальный остаток')}+${sum('Выдача займа')}-${sum('Удержание из зарплаты')}-${sum('Возврат вне зарплаты')})`;
   add('Q',r.debt,3,qformula);add('R',r.previousAccrued,3,r.row.previousAccruedLinked?linkedFormula(state,key,'J',row):null);add('S',r.row.note,0);add('T',r.previousHours,0,r.row.previousHoursLinked?linkedFormula(state,key,'E',row):null);
   out.push(rowXml(row,a));
 });
 const tr=rs.length+4,t=C.calcTotals(state,key),cells=[xn('B'+tr,'ИТОГО',2)];
 const summary={C:t.shifts,E:t.hours,F:t.overtimePay,G:t.extras,H:t.bonus,J:t.accrued,K:t.card,L:t.advance,M:t.fine,N:t.deduction,O:t.loanPayment,P:t.due,Q:t.debt,R:t.previousAccrued};
 for(const [col,val] of Object.entries(summary))cells.push(xn(col+tr,val,3,`SUM(${col}4:${col}${tr-1})`));
 out.push(rowXml(tr,cells));
 return docSheet(out,[4.5,30,8,12,9,12,12,12,3,14,14,12,12,14,14,14,14,17,44,13],`A1:T1`);
}
function buildEmployeesSheet(state){
 const rows=[],hs=['№','ФИО','Должность','Оплата','Ставка, ₽','2-я ставка, ₽','Телефон','Гражданство','Дата рождения','Принят','Карта / банк','Документы','Заметки'];
 rows.push(rowXml(1,hs.map((v,i)=>xn(xref(i+1)+'1',v,2))));
 state.employees.forEach((e,i)=>{
  const values=[i+1,e.name,e.position,e.payType,e.rate,e.secondRate,e.phone,e.citizenship,e.dob,e.joined,e.bank,e.documents,e.notes];
  rows.push(rowXml(i+2,values.map((v,j)=>xn(xref(j+1)+(i+2),v,j===4||j===5?3:0))));
 });
 return docSheet(rows,[5,36,23,26,14,14,18,16,14,14,28,32,48],null,'none');
}
function buildJournalSheet(state){const rows=[];
 const hs=['Дата операции','Сотрудник','Вид операции','Сумма, ₽','В счёт месяца','Основание / примечание'];
 rows.push(rowXml(1,hs.map((v,i)=>xn(xref(i+1)+'1',v,2))));
 const names=new Map(state.employees.map(e=>[e.id,e.name]));
 state.operations.forEach((o,i)=>{const row=i+2;const values=[jsDateSerial(o.date),names.get(o.employeeId)||'(сотрудник не найден)',o.type,o.amount,o.month,o.note];
 rows.push(rowXml(row,values.map((v,j)=>xn(xref(j+1)+row,v,j===0?4:j===3?3:0))));});
 return docSheet(rows,[16,37,30,18,17,54],null,'none');}
function buildControlsSheet(state){const rows=[];let i=1;
 rows.push(rowXml(i++,[xn('A1','КОНТРОЛЬ И ИСТОЧНИК',1)]));
 rows.push(rowXml(i++,[xn('A2','Источник'),xn('B2',state.source?.name||'') ]));
 rows.push(rowXml(i++,[xn('A3','SHA-256'),xn('B3',state.source?.sha256||'')]));
 rows.push(rowXml(i++,[xn('A4','Примечание'),xn('B4','Реконструкция на основе Excel. Исходный код Claude не извлечён.')]));
 rows.push(rowXml(i++,[xn('A5','Особенность'),xn('B5','Исходные исключения «К выдаче» оставлены фиксированными только там, где они заданы пользователем.')]));
 i++;for(const k of Object.keys(state.months).sort()){const t=C.calcTotals(state,k);rows.push(rowXml(i,[xn('A'+i,k),xn('B'+i,'Начислено'),xn('C'+i,t.accrued,3),xn('D'+i,'К выдаче'),xn('E'+i,t.due,3)]));i++;}
 i++;for(const k of Object.keys(state.months).sort())for(const w of C.warnings(state,k)){rows.push(rowXml(i,[xn('A'+i,w.severity),xn('B'+i,k+' — '+w.text)]));i++;}
 return docSheet(rows,[20,108,20,17,20],null,'none');}
function utf8(s){return new TextEncoder().encode(s);}function u16(arr,i,n){arr[i]=n&255;arr[i+1]=(n>>>8)&255;}function u32(arr,i,n){arr[i]=n&255;arr[i+1]=(n>>>8)&255;arr[i+2]=(n>>>16)&255;arr[i+3]=(n>>>24)&255;}
let crctable=null;
function crc32(data){if(!crctable){crctable=Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});}let c=0xffffffff;for(const b of data)c=crctable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function zip(files){let offset=0,parts=[],central=[];const date=(46<<9)|(11<<5)|23,time=(9<<11)|(0<<5);
 for(const [filename,body] of files){const name=utf8(filename),data=utf8(body),crc=crc32(data),header=new Uint8Array(30+name.length);u32(header,0,0x04034b50);u16(header,4,20);u16(header,6,0x800);u16(header,8,0);u16(header,10,time);u16(header,12,date);u32(header,14,crc);u32(header,18,data.length);u32(header,22,data.length);u16(header,26,name.length);header.set(name,30);parts.push(header,data);
 const c=new Uint8Array(46+name.length);u32(c,0,0x02014b50);u16(c,4,20);u16(c,6,20);u16(c,8,0x800);u16(c,10,0);u16(c,12,time);u16(c,14,date);u32(c,16,crc);u32(c,20,data.length);u32(c,24,data.length);u16(c,28,name.length);u32(c,42,offset);c.set(name,46);central.push(c);offset+=header.length+data.length;}
 const centralStart=offset,centralLen=central.reduce((s,c)=>s+c.length,0),end=new Uint8Array(22);u32(end,0,0x06054b50);u16(end,8,central.length);u16(end,10,central.length);u32(end,12,centralLen);u32(end,16,centralStart);
 return new Blob([...parts,...central,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
function workbook(state){const ks=Object.keys(state.months).sort(),names=ks.map(k=>'ЗП '+k.slice(5)+'-'+k.slice(0,4));names.push('Сотрудники','Журнал','Контроль');
 const sheets=ks.map(k=>buildMonthSheet(state,k)).concat([buildEmployeesSheet(state),buildJournalSheet(state),buildControlsSheet(state)]);
 const contentTypes=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
 const wb=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((s,i)=>`<sheet name="${esc(s)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets><calcPr fullCalcOnLoad="1" calcMode="auto"/></workbook>`;
 const rels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
 const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
 const styles=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="# ##0.00\\ ₽;[Red]\\-# ##0.00\\ ₽"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Aptos"/></font><font><b/><sz val="17"/><color rgb="FF233D5B"/><name val="Aptos Display"/></font><font><b/><sz val="10"/><color rgb="FF243953"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDFEAF8"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
 return zip([['[Content_Types].xml',contentTypes],['_rels/.rels',rootRels],['xl/workbook.xml',wb],['xl/_rels/workbook.xml.rels',rels],['xl/styles.xml',styles],...sheets.map((s,i)=>[`xl/worksheets/sheet${i+1}.xml`,s])]);
}
root.PayrollExcel={workbook};
if(typeof module!=='undefined'&&module.exports)module.exports={workbook};
})(typeof window!=='undefined'?window:globalThis);
