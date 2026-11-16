'use strict';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('public/app.js','utf8');
// The form is authored in JSX; the HTML document is now only a React mount.
const form=fs.readFileSync('ui/board/EventForm.tsx','utf8');
const basic=form.slice(0,form.indexOf('<Advanced>'));
for(const name of ['description','minimum_participants','bot_enabled'])assert.match(basic,new RegExp(`name="${name}"`));
assert.ok(!/<(?:Field|textarea)[^>]+name="fee_policy"/.test(form));
assert.match(form,/data\.fee_policy\s*=\s*v\.fee_policy/);
assert.match(fs.readFileSync('public/index.html','utf8'),/id="board-root"/);

const f={
  fee_policy:{value:'舊費用：每人 100，后台後臺原文',disabled:false},
  description:{value:'集合地点原文',maxLength:3000,focus(){this.focused=true;},dispatchEvent(event){this.dispatched=event.type;}},
  visibility:{value:'public'},bot_enabled:{checked:true,disabled:false,dataset:{editable:'true'}},
};
const nodes={'#event-form':{elements:f},'#event-legacy-fee':{},'#event-legacy-fee-text':{},'#event-merge-fee':{},'#event-bot-visibility':{},'.form-error':{}};
const context=vm.createContext({$:selector=>nodes[selector],Event:class{constructor(type){this.type=type;}}});
vm.runInContext(source.slice(source.indexOf('function updateLegacyFeeNotice()'),source.indexOf("$('#event-merge-fee').addEventListener"))+';this.formOptions={updateLegacyFeeNotice,mergeLegacyFee,updateEventBotOption};',context);
const {updateLegacyFeeNotice,mergeLegacyFee,updateEventBotOption}=context.formOptions;
updateLegacyFeeNotice();
assert.equal(nodes['#event-legacy-fee'].hidden,false);
assert.equal(nodes['#event-legacy-fee-text'].textContent,f.fee_policy.value);
assert.equal(nodes['#event-merge-fee'].hidden,false);
const original=f.fee_policy.value;
f.fee_policy.disabled=true;updateLegacyFeeNotice();mergeLegacyFee();
assert.equal(nodes['#event-merge-fee'].hidden,true);assert.equal(f.fee_policy.value,original);assert.equal(f.description.value,'集合地点原文');
f.fee_policy.disabled=false;f.description.value='a'.repeat(3000);mergeLegacyFee();
assert.equal(f.description.value.length,3000);assert.equal(f.fee_policy.value,original);assert.match(nodes['.form-error'].textContent,/超出/);
f.description.value='集合地点原文';mergeLegacyFee();
assert.equal(f.description.value,'集合地点原文\n\n'+original);assert.equal(f.fee_policy.value,'');assert.equal(nodes['#event-legacy-fee'].hidden,true);
assert.equal(f.description.dispatched,'input');assert.equal(nodes['.form-error'].textContent,'');
mergeLegacyFee();assert.equal(f.description.value,'集合地点原文\n\n'+original,'Merging twice never duplicates old text');

updateEventBotOption();assert.equal(f.bot_enabled.disabled,false);assert.equal(f.bot_enabled.checked,true);
f.visibility.value='invitation';updateEventBotOption();
assert.equal(f.bot_enabled.disabled,true);assert.equal(f.bot_enabled.checked,false);assert.equal(nodes['#event-bot-visibility'].hidden,false);
f.visibility.value='public';updateEventBotOption();
assert.equal(f.bot_enabled.disabled,false);assert.equal(f.bot_enabled.checked,false);assert.equal(nodes['#event-bot-visibility'].hidden,true);
f.bot_enabled.dataset.editable='false';f.bot_enabled.checked=true;updateEventBotOption();
assert.equal(f.bot_enabled.disabled,true);assert.equal(f.bot_enabled.checked,true,'Keep owner setting visible to non-owner editors');

console.log('Basic event fields, single notes editor, lossless legacy merge, permission guards and invitation sync passed');
