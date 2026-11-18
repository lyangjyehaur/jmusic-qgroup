import { describe,it,expect } from 'vitest';
import { describeLegacy,legacyRaw,legacyBlocks,legacyCreateIntent } from '../../web/src/legacy-local-record';
const scope='a'.repeat(64),fields=[{name:'title',value:'原標題',checked:undefined},{name:'id',value:''}],base={at:123,key:'draft:'+scope+':event:new',data:{fields,dataset:{intent:'original',revision:'7'}}};
describe('original BoardStore snapshot classification and lossless preservation',()=>{
  it('preserves property order, explicit undefined, fixed revisions, create intent and exact image bytes in tagged exports',()=>{
    const raw=legacyRaw({...base,data:{...base.data,receipt:'iVBORexact',paymentCodes:[{image:'iVBORother'}]}}),saved=JSON.parse(raw);
    expect(saved).toMatchObject({format:'kanban-local-v1-preserved',version:1});expect(raw).toContain('undefined');expect(raw).toContain('iVBORexact');expect(raw).toContain('original');expect(raw).toContain('revision');expect(raw).toContain('7');
    expect(legacyRaw({a:1,b:2})).not.toBe(legacyRaw({b:2,a:1}));expect(legacyRaw(-0)).not.toBe(legacyRaw(0));expect(legacyRaw(new Array(1))).not.toBe(legacyRaw([undefined]));expect(()=>legacyRaw(new Uint8Array([1,2]))).toThrow('原儲存保留');
  });
  it('recognizes all six original form families without deleting extra fields or rebasing input',()=>{
    expect(describeLegacy(base,scope)).toMatchObject({kind:'draft',route:'/activities/new',data:base.data});
    for(const [suffix,data,route] of [['copy:listen',base.data,'/activities/new'],['event:listen',{...base.data,fields:[...fields.filter(f=>f.name!=='id'),{name:'id',value:'listen'}]},'/activities/listen'],['time-poll:new',{fields,slots:[{id:'slot',date:'2099-01-01'}],intent:'fixed'},'/time-polls/new'],['rooms:listen',{rooms:[],revision:8},'/activities/listen/rooms'],['invoice:listen',{fields,people:[],items:[],event:{revision:8},unknown:'retained'},'/activities/listen/settlement/edit'],['finance:listen:record:new',{fields,edit:{recordId:'fixed'},revision:7},'/activities/listen/finance']] as const){
      const source={...base,key:'draft:'+scope+':'+suffix,data};expect(describeLegacy(source,scope)).toMatchObject({kind:'draft',data,route});
    }
  });
  it('keeps original request identifiers and exact JSON insertion order and isolates scope',()=>{
    const source={key:'request:'+scope+':'+'b'.repeat(64),scope,method:'POST',path:'/api/events',data:{z:'last',a:'first'},requestKey:'c'.repeat(64),status:'done',at:12};
    expect(describeLegacy(source,scope).request).toEqual({requestKey:source.requestKey,path:source.path,method:source.method,data:source.data});expect(describeLegacy(source,'d'.repeat(64)).kind).toBe('unknown');
    for(const patch of [{scope:'d'.repeat(64)},{status:'damaged'},{requestKey:'short'},{key:source.key+'x'}])expect(describeLegacy({...source,...patch},scope).kind).toBe('unknown');
  });
  it('blocks related editors and keeps unknown scoped shapes as blockers',()=>{
    expect(legacyBlocks(describeLegacy(base,scope),'/activities/new')).toBe(true);expect(legacyBlocks(describeLegacy(base,scope),'/time-polls/new')).toBe(false);
    const unknown=describeLegacy({...base,key:'draft:'+scope+':future'},scope);expect(unknown.kind).toBe('unknown');expect(legacyBlocks(unknown,'/activities/listen/finance')).toBe(true);
    expect(()=>describeLegacy(base,'bad')).toThrow();
  });
  it('recognizes current React captures for all five families without altering their inner values or outer revision',()=>{
    const intent='11111111-1111-4111-8111-111111111111';
    const values=[['event:new',{id:'',title:'原文',_intent:intent,_revision:'',_lifecycle:'',timezone:'America/New_York',unknown:'preserved'},'/activities/new'],['event:listen',{id:'listen',title:'原編輯',_intent:intent,_revision:7,_lifecycle:'draft'},'/activities/listen'],['copy:listen',{id:'',title:'原複製',_intent:intent,_revision:'',_lifecycle:''},'/activities/new'],['time-poll:new',{title:'原投票',client_intent:intent,slots:[{key:'original-slot',date:'2099-01-01',time:''}],deadlineTouched:true},'/time-polls/new'],['rooms:listen',{rooms:[{id:'original-room',person_ids:['person']}]},'/activities/listen/rooms'],['invoice:listen',{people:[],items:[{receipt:{version:3,item_id:'original-image'}}],codes:[{kind:'other',version:3}]},'/activities/listen/settlement/edit'],['finance:listen:record:new',{recordId:'original-record',kind:'collection',amount:'7.25'},'/activities/listen/finance']] as const;
    for(const [suffix,value,route] of values){const data={react:1,value,revision:7},description=describeLegacy({...base,key:'draft:'+scope+':'+suffix,data},scope);expect(description).toMatchObject({kind:'draft',data,route});expect(legacyRaw(data)).toContain('7');if(route==='/activities/new'||route==='/time-polls/new')expect(legacyCreateIntent(description)).toEqual({kind:route==='/activities/new'?'activity':'poll',intent});else expect(legacyCreateIntent(description)).toBeNull();}
    expect(legacyCreateIntent(describeLegacy({...base,data:{...base.data,dataset:{intent}}},scope))).toEqual({kind:'activity',intent});expect(legacyCreateIntent(describeLegacy(base,scope))).toBeNull();
  });
  it('blocks incompatible React versions and mismatched form identities instead of treating edits as another create',()=>{
    for(const data of [{react:2,value:{id:'',title:'future'}},{react:1,value:{id:'different',title:'original',_intent:'x',_revision:7,_lifecycle:'draft'},revision:7},{react:1,value:[],revision:7}])expect(describeLegacy({...base,key:'draft:'+scope+':event:listen',data},scope).kind).toBe('unknown');
    expect(describeLegacy({...base,key:'draft:'+scope+':event:listen'},scope).kind).toBe('unknown');
  });
});
