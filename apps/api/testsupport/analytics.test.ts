import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '@qgroup/database';
import { ANALYTICS_HOST, ANALYTICS_ORIGIN, ANALYTICS_WEBSITE } from '@qgroup/contracts';
import { createApp } from '../src/app';
import { analyticsManifestSource } from '../../../tools/rebuild/build-analytics-manifest';
import { analyticsOperation, analyticsRoute, safeAnalyticsPayload, startAnalytics } from '../../web/src/analytics';
it('keeps the manifest consistent with current static route and control declarations', () => {
  expect(readFileSync('apps/web/src/analytics-manifest.ts','utf8')).toBe(analyticsManifestSource(resolve('.')));
});
it('classifies native pages without sending record IDs, invitations, queries or unknown paths', () => {
  for(const [path,expected] of [['/activities/new','/activities/new'],['/time-polls/new','/time-polls/new'],['/activities/PRIVATE_EVENT/share','/activities/:id/share'],['/activities/PRIVATE_EVENT/access/SECRET_TOKEN','/activities/:id/access/:id'],['/me/devices/accept','/me/devices/accept'],['/music/entries/PRIVATE_ID','/music/entries/:id'],['/admin/users/PRIVATE_PERSON','/admin/users/:id'],['/PRIVATE_PATH/SECRET','/unknown']])expect(analyticsRoute(path!)).toBe(expected);
});
it('classifies known write endpoints by complete templates rather than preserving guessed words or parameter values', () => {
  expect(analyticsOperation('/api/v2/activities/PRIVATE_EVENT/attendees/SECRET_PERSON/conditions?token=SECRET')).toBe('/api/v2/activities/:id/attendees/:id/conditions');
  expect(analyticsOperation('/api/v2/auth/qq/start?code=SECRET')).toBe('/api/v2/auth/qq/start');
  expect(analyticsOperation('/api/v2/PRIVATE_PATH/SECRET')).toBe('unknown');
  expect(analyticsOperation('https://external.example/api/v2/auth/qq/start')).toBe('unknown');
});
it('rebuilds payloads from an explicit whitelist and preserves only permitted booleans and bounded results', () => {
  const result=safeAnalyticsPayload({url:'/activities/:id/share',title:'PRIVATE_TITLE',referrer:'/admin/users/:id',name:'api_result',data:{page:'SECRET_PAGE',language:'SECRET_LANG',control:'SECRET_CONTROL',context:'SECRET_CONTEXT',nickname:'PRIVATE_NAME',amount:12345,token:'SECRET_TOKEN',operation:'/api/v2/me/profile',method:'PUT',status:409,outcome:'rejected',checked:false}}, {width:360,height:800}, 'zh-Hans');
  expect(result).toMatchObject({website:ANALYTICS_WEBSITE,url:'/activities/:id/share',title:'Qgroup /activities/:id/share',referrer:'/admin/users/:id',language:'zh-Hans',screen:'360x800',data:{page:'/activities/:id/share',language:'zh-Hans',method:'PUT',status:409,outcome:'rejected',checked:false}});
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|12345/);
  const bad=safeAnalyticsPayload({url:'//SECRET_HOST/path?token=SECRET',title:'PRIVATE_TITLE',referrer:'https://PRIVATE_HOST/?token=SECRET',name:'ui_click',data:{status:9999,method:'SECRET_METHOD',outcome:'SECRET_RESULT'}},{width:NaN,height:Infinity},'PRIVATE_LANGUAGE');
  expect(bad).toMatchObject({url:'/unknown',referrer:'/unknown',language:'zh-Hant',screen:'0x0',data:{page:'/unknown',language:'zh-Hant'}});expect(JSON.stringify(bad)).not.toMatch(/SECRET|PRIVATE/);
});
it('only permits the configured production tracker in CSP and ignores forged request hosts', async () => {
  for(const origin of [ANALYTICS_ORIGIN,'http://kanban.danndann.cn','https://kanban.danndann.cn.external.example','http://127.0.0.1:8791']){
    const db=openDatabase(':memory:'),app=createApp({db,origin});
    try{const r=await app.inject({url:'/api/v2/health',headers:{host:'kanban.danndann.cn'}});expect(r.statusCode).toBe(200);expect(r.headers['content-security-policy']?.includes(ANALYTICS_HOST)).toBe(origin===ANALYTICS_ORIGIN);expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({n:0});}finally{await app.close();db.close();}
  }
});
it('does not even inspect the document or install listeners on a non-production origin', () => {
  for(const origin of ['http://127.0.0.1:5082','http://kanban.danndann.cn','https://kanban.danndann.cn.external.example']) {
    const doc=new Proxy({},{get(){throw Error('Document must not be touched');}}) as Document;
    expect(()=>startAnalytics({location:{origin}} as unknown as Parameters<typeof startAnalytics>[0],doc)()).not.toThrow();
  }
});
