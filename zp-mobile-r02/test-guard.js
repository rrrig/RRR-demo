/* Public test-only guard. No production data import. */
window.IGNIS_PAYROLL_DEMO = true;
document.addEventListener('change', function(e){
  if(e.target?.matches?.('input[type="file"]:not(.profile-file)')){
    e.stopImmediatePropagation();
    e.target.value='';
    alert('В публичную тестовую версию запрещено загружать настоящие зарплатные данные. Используйте только вымышленные записи.');
  }
}, true);
document.addEventListener('submit', function(e){
  if(e.target?.id === 'cloud-form' || e.target?.id === 'encrypted-form'){
    e.preventDefault(); e.stopImmediatePropagation();
    alert('В пробной версии восстановление реальных данных отключено.');
  }
}, true);
