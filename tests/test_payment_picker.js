import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// A new settlement image must work without writing the account library.
// Choosing to save, retrying a failure and reopening another event must not
// lose the selected image or accidentally save a stale selection.
for(const folder of ['hans','hant']) {
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(`public/locales/${folder}/payment-codes.js`,'utf8'),context);
  const handlers={},requests=[],prompts=[],errors=[];
  let fail=false,busy=0;
  const container={innerHTML:'',inert:false,querySelector:selector=>selector.includes('data-code-name')?{value:'我的后台後臺'}:null,addEventListener:(type,handler)=>handlers[type]=handler};
  const picker=context.createPaymentCodePicker({$:()=>container,esc:String,
    prepareCode:async()=> 'data:image/png;base64,TEST',
    api:async(path,method,data)=>{requests.push({path,method,data});if(fail)throw new Error('offline');return {id:'abc',kind:data.kind,name:data.name,url:'/api/payment-codes/abc/image'};},
    askConfirm:(title,message,callback,labels)=>prompts.push({callback,labels}),
    onChange:()=>{},onError:error=>errors.push(error.message),startBusy:()=>{busy++;return ()=>busy--;}
  });
  picker.open({id:'event1',settlement:null},[]);
  const upload=()=>handlers.change({target:{dataset:{codeUpload:'wechat'},files:[{}]}});
  await upload();
  assert.equal(requests.length,0,'No automatic library save before the choice');
  assert.equal(picker.value()[0].image,'TEST');
  assert.equal(picker.cards()[0].name,'我的后台後臺');
  assert.equal(prompts.length,1);
  assert.ok(prompts[0].labels.cancel);
  assert.equal(busy,0);
  const draft=JSON.parse(JSON.stringify(picker.value()));
  picker.restore(draft);
  assert.equal(picker.cards()[0].url,'data:image/png;base64,TEST');
  // Discard a pending save prompt when its original editor no longer exists.
  await prompts[0].callback();
  assert.equal(requests.length,0);
  await upload();fail=true;await prompts[1].callback();
  assert.equal(errors[0],'offline');
  assert.equal(picker.value()[0].image,'TEST','Save failure retains this bill image');
  assert.equal(container.inert,false);
  fail=false;await prompts[1].callback();
  assert.equal(requests.at(-1).data.name,'我的后台後臺');
  assert.equal(picker.value()[0].code_id,'abc');
  assert.equal(picker.value()[0].image,undefined);
  await upload();const before=requests.length;
  picker.open({id:'event2',settlement:null},[]);
  await prompts.at(-1).callback();
  assert.equal(requests.length,before,'An old prompt cannot save into another editor');
  assert.equal(busy,0);
}
console.log('Hans/Hant optional payment-code saves, drafts, retry and stale prompt protection passed');
