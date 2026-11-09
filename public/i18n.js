'use strict';
// HTML and assets use the same primary Accept-Language choice on the server.
// Only system-owned literals are converted at build time; user values stay raw.
const BoardI18n=(()=>{
  const locale=document.documentElement.lang;
  const categories={'全部':'全部','约K':'唱歌','聚餐':'聚餐','运动':'运动','出游':'出游','游戏':'游戏','其他':'其他'};
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
    let message='请检查这个栏位。';
    if(validity.valueMissing)message=field.type==='checkbox'?'请先勾选此项。':field.tagName==='SELECT'?'请选择一项。':'请填写这个栏位。';
    else if(validity.typeMismatch)message='请填写正确的格式。';
    else if(validity.rangeUnderflow)message=`请输入不小于 ${field.min} 的值。`;
    else if(validity.rangeOverflow)message=`请输入不大于 ${field.max} 的值。`;
    else if(validity.tooLong)message=`请将内容缩短至 ${field.maxLength} 字以内。`;
    else if(validity.tooShort)message=`请至少填写 ${field.minLength} 字。`;
    else if(validity.stepMismatch||validity.badInput)message='请填写有效的数值或时间。';
    else if(validity.patternMismatch)message='请按要求的格式填写。';
    field.setCustomValidity(message);localized.add(field);
  },true);
  return {locale,defaultItemName:'活动费用',category:value=>categories[value]||value};
})();
