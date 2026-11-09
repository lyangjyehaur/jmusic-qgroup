'use strict';
// HTML and assets use the same primary Accept-Language choice on the server.
// Only system-owned literals are converted at build time; user values stay raw.
const BoardI18n=(()=>{
  const locale=document.documentElement.lang;
  const categories={'全部':"全部",'约K':"唱歌",'聚餐':"聚餐",'运动':"運動",'出游':"出遊",'游戏':"遊戲",'其他':"其他"};
  // Native validation uses the browser language, which can be English. Keep
  // standard field errors in the same Chinese variant as the page instead.
  const localized=new WeakSet();
  function reset(event) {
    if(localized.has(event.target)) {
      event.target.setCustomValidity('');localized.delete(event.target);
    }
  }
  document.addEventListener('input',reset,true);
  document.addEventListener('change',reset,true);
  document.addEventListener('invalid',event=>{
    const field=event.target;
    if(typeof field.setCustomValidity!=='function')return;
    if(localized.has(field)){field.setCustomValidity('');localized.delete(field);}
    const validity=field.validity;
    if(validity.customError)return;
    let message="請檢查這個欄位。";
    if(validity.valueMissing)message=field.type==='checkbox'?"請先勾選此項。":field.tagName==='SELECT'?"請選擇一項。":"請填寫這個欄位。";
    else if(validity.typeMismatch)message="請填寫正確的格式。";
    else if(validity.rangeUnderflow)message=`請輸入不小於 ${field.min} 的值。`;
    else if(validity.rangeOverflow)message=`請輸入不大於 ${field.max} 的值。`;
    else if(validity.tooLong)message=`請將內容縮短至 ${field.maxLength} 字以內。`;
    else if(validity.tooShort)message=`請至少填寫 ${field.minLength} 字。`;
    else if(validity.stepMismatch||validity.badInput)message="請填寫有效的數值或時間。";
    else if(validity.patternMismatch)message="請按要求的格式填寫。";
    field.setCustomValidity(message);localized.add(field);
  },true);
  return {locale,defaultItemName:"活動費用",category:value=>categories[value]||value};
})();
