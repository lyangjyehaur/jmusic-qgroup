import { it,expect } from 'vitest';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHttpOperationSources } from '../../../tools/rebuild/build-http-contracts';

function inventory(source:string){
 const root=mkdtempSync(join(tmpdir(),'qgroup-query-source-'));
 try{mkdirSync(join(root,'apps/api/src'),{recursive:true});writeFileSync(join(root,'apps/api/src/routes.ts'),source);return readHttpOperationSources(root);}
 finally{rmSync(root,{recursive:true,force:true});}
}
it('binds shared query contracts through lexical helpers and loop-generated routes',()=>{
 const rows=inventory(`import { BotDeliveriesQuery } from '@qgroup/contracts';
 function register(app){
  function list(request){return BotDeliveriesQuery.parse(request.query);}
  app.get('/api/v2/admin/bot/deliveries',request=>list(request));
  for(const segment of ['activities','time-polls'])app.get('/api/v2/'+segment+'/:id/bot-deliveries',request=>list(request));
 }`);
 expect(rows.map(row=>row.id)).toEqual(['GET /api/v2/activities/:id/bot-deliveries','GET /api/v2/admin/bot/deliveries','GET /api/v2/time-polls/:id/bot-deliveries']);
 expect(rows.every(row=>row.query==='BotDeliveriesQuery'&&row.body===null)).toBe(true);
});
it.each(['raw query read','inline query schema','ambiguous query schema','unattached query helper'])('rejects %s in the source contract graph',mode=>{
 let source="import { PageQuery,ActivitiesQuery } from '@qgroup/contracts';";
 if(mode==='raw query read')source+="app.get('/api/v2/activities',request=>request.query);";
 if(mode==='inline query schema')source+="app.get('/api/v2/activities',request=>z.object({}).parse(request.query));";
 if(mode==='ambiguous query schema')source+="app.get('/api/v2/activities',request=>{PageQuery.parse(request.query);return ActivitiesQuery.parse(request.query);});";
 if(mode==='unattached query helper')source+="app.get('/api/v2/activities',()=>[]);function unused(request){return PageQuery.parse(request.query);}";
 expect(()=>inventory(source)).toThrow(Error);
});
