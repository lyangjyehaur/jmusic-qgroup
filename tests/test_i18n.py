import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime,timedelta,timezone
from pathlib import Path

import server
from qgroup_core import i18n
from test_roster import ModernClient


class LanguageTests(unittest.TestCase):
    def test_only_primary_simplified_chinese_selects_simplified(self):
        cases={
            'zh-CN':'hans','zh-SG':'hans','zh-Hans':'hans','zh-Hans-TW':'hans',
            'ZH_cn':'hans','zh-TW':'hant','zh-HK':'hant','zh-MO':'hant',
            'zh-Hant-CN':'hant','zh':'hant','en-US,zh-CN;q=0.9':'hant',
            'ja':'hant','fr':'hant','':'hant','*':'hant',
            'en;q=0.2,zh-CN;q=0.9':'hans','zh-CN;q=0,en-US;q=1':'hant',
            'zh-CN;q=broken,en':'hant',
        }
        for header,expected in cases.items():
            with self.subTest(header=header):self.assertEqual(i18n.language(header),expected)

    def test_name_bearing_errors_translate_only_system_suffix(self):
        name='发后臺报名 · 张发'
        suffix=' 的份数、缺席／退出或约定差异需要核对原因'
        self.assertEqual(i18n.error(name+suffix,'hant'),name+' 的份數、缺席／退出或約定差異需要核對原因')
        self.assertEqual(i18n.error(name+suffix,'hans'),name+suffix)

    def test_user_fields_and_wire_values_remain_original(self):
        raw='后台发起 · 發後臺 · 报名须知'
        source={'title':raw,'nickname':raw,'name':raw,'note':raw,'reason':raw,
                'location':raw,'description':raw,'fee_policy':raw,'merchant':raw,
                'category':'运动','status':'confirmed','payer_kind':'manager'}
        for locale in ('hans','hant'):self.assertEqual(i18n.payload(source,locale),source)

    def test_notification_and_arrangement_keep_names_and_reasons(self):
        name='张发后臺';reason='报名须知照旧 · 後臺'
        source={'kind':'withdrawal_request','message':name+' 申请退出：'+reason}
        self.assertEqual(i18n.payload(source,'hant')['message'],name+' 申請退出：'+reason)
        summary='时间、费用规则已变更：'+reason
        self.assertEqual(i18n.arrangement(summary,'hant'),'時間、費用規則已變更：'+reason)
        # If a user value looks like a template separator, do not guess boundaries.
        ambiguous='张 申请退出：发 申请退出：'+reason
        self.assertEqual(i18n.notification(ambiguous,'withdrawal_request','hant'),ambiguous)

    def test_settlement_changes_and_duplicate_labels_preserve_user_text(self):
        name='张发后臺'
        source={'name':name,'label':name+'（报名 2）','changes':[
            name+'：应付 100.00 → 50.00 元；共同份数 1 → 0.5',
            '备注：后台原话 → 發後臺原話',
        ]}
        result=i18n.payload(source,'hant')
        self.assertEqual(result['label'],name+'（報名 2）')
        self.assertEqual(result['changes'][0],name+'：應付 100.00 → 50.00 元；共同份數 1 → 0.5')
        self.assertEqual(result['changes'][1],'備註：后台原话 → 發後臺原話')
        self.assertEqual(source['label'],name+'（报名 2）')
        self.assertEqual(i18n.change(name+' 出席：unknown → present','hant'),name+' 出席：未登記 → 到場')

    def test_joined_numeric_close_errors_and_original_reason(self):
        self.assertEqual(i18n.error('尚有待补款 ¥20.00；仍有活动代收资金未支出或退还','hant'),
                         '尚有待補款 ¥20.00；仍有活動代收資金未支出或退還')
        value='先发布核对后的逐人结算；旧人均账单需明确转换；仍有待核对的款项申报'
        self.assertEqual(i18n.error(value,'hant'),'先發布核對後的逐人結算；舊人均帳單需明確轉換；仍有待核對的款項申報')


class LanguageHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'i18n.sqlite3';server.initialize()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()

    def get(self,path,language=None,method='GET'):
        headers={} if language is None else {'Accept-Language':language}
        try:r=urllib.request.urlopen(urllib.request.Request(self.base+path,headers=headers,method=method))
        except urllib.error.HTTPError as problem:r=problem
        return r,r.read()

    def test_html_help_js_and_accessibility_labels_follow_language_without_login(self):
        for language,folder,lang in [('zh-CN','hans','zh-Hans'),('zh-TW','hant','zh-Hant'),('en-US,zh-CN;q=0.8','hant','zh-Hant'),(None,'hant','zh-Hant')]:
            for route,name in [('/','index.html'),('/guide.html','guide.html'),('/app.js','app.js'),('/roster.js','roster.js'),('/i18n.js','i18n.js'),('/analytics.js','analytics.js'),('/privacy','privacy.html'),('/contact','contact.html'),('/admin','admin.html')]:
                with self.subTest(language=language,route=route):
                    response,body=self.get(route,language)
                    self.assertEqual(response.status,200)
                    self.assertEqual(response.headers['Content-Language'],lang)
                    self.assertEqual(response.headers['Vary'],'Accept-Language')
                    self.assertIsNone(response.headers.get('Set-Cookie'))
                    self.assertEqual(body,(server.ROOT/'public/locales'/folder/name).read_bytes())
                    if name.endswith('.html'):
                        self.assertIn(b'/analytics.js?v=20261109-umami2',body)
                        self.assertIn(b'data-auto-track="false"',body)
                        self.assertIn(b'5244d326-3db9-4499-9c7a-6e3568b296cd',body)
                        csp=response.headers['Content-Security-Policy']
                        self.assertIn("script-src 'self' https://u.danndann.cn;",csp)
                        self.assertIn("connect-src 'self' https://u.danndann.cn;",csp)
            response,body=self.get('/guide.html',language,'HEAD')
            self.assertEqual(response.status,200);self.assertEqual(body,b'')
        with sqlite3.connect(server.DB) as db:self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0],0)

    def test_http_errors_translate_and_keep_status(self):
        for language,expected in [('zh-CN','页面不存在'),('en','頁面不存在'),('zh-Hant','頁面不存在')]:
            response,body=self.get('/does-not-exist',language)
            self.assertEqual(response.status,404)
            self.assertEqual(json.loads(body)['error'],expected)

    def test_same_event_values_are_identical_between_languages(self):
        server.LIMITS.clear()
        owner=ModernClient(self.base).identify('张发后臺')
        start=(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()
        raw='后台后臺 · 报名须知'
        status,created=owner.request('/api/events','POST',dict(title=raw,location=raw,description=raw,
            fee_policy=raw,category='运动',starts_at=start,deadline=start,capacity=0,duration_hours=3))
        self.assertEqual(status,201)
        for language in ('zh-CN','zh-TW','en-US'):
            status,event=owner.request('/api/events/'+created['id'],headers={'Accept-Language':language})
            self.assertEqual(status,200)
            for key in ('title','location','description','fee_policy'):self.assertEqual(event[key],raw)
            self.assertEqual(event['category'],'运动')
            self.assertEqual(event['owner_name'],'张发后臺')
            self.assertEqual(event['my_registration']['nickname'],'张发后臺')
            self.assertEqual(event['confirmed_count'],1)
