"""Local browser fixture: temporary databases, synthetic QQ, no external traffic."""
import json
import os
import signal
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
from test_music_site import MusicTests
from test_roster import ModernClient
import server
from music_site import service


def main():
    MusicTests.setUpClass()
    fixture = MusicTests()
    fixture._testMethodName = 'react_ui_fixture'
    fixture.setUp()
    try:
        fixture.start_entry(name='饭团', contactQQ='23456789')
        fixture.authorize()
        fixture.finish_entry()
        fixture.request('/api/profile', 'POST', {'nickname': '饭团'})
        fixture.origin = server.ORIGIN = service.ORIGIN = fixture.base
        os.environ['KANBAN_ORIGIN'] = fixture.base
        os.environ['KANBAN_QQ_REDIRECT_URI'] = fixture.base+'/auth/qq/callback'
        # Both services use the local partner API, never the production default.
        partner_key = 'local-preview-partner-' + 'p' * 40
        os.environ['KANBAN_PUBLIC_API_KEYS'] = partner_key
        os.environ['QGROUP_API_KEY'] = partner_key
        service.upstream.QGROUP_BASE = fixture.base + '/api/public/v1'
        service.upstream._qgroup_cache.clear()
        other = ModernClient(fixture.base)
        other.request('/api/me')
        status, result = fixture.request('/music/api/entry/start', 'POST', {'consent':True, 'name':'小林'}, client=other)
        assert status == 200, result
        fixture.authorize(client=other, subject='B' * 32)
        status, result = fixture.request('/music/api/entry/complete', 'POST', {}, client=other)
        assert status == 200, result
        fixture.request('/api/profile', 'POST', {'nickname':'小林'}, client=other)
        with server.connect() as db:
            db.execute('INSERT INTO user_admin_roles SELECT id,1,1,? FROM users',
                       (datetime.now(timezone.utc).isoformat(),))
            db.commit()
        for i, title in enumerate(['周末来唱喜欢的歌', '吃顿饭，聊聊最近', '一起去公园散步']):
            start = datetime.now(timezone.utc) + timedelta(days=i+2)
            status, result = fixture.request('/api/events', 'POST', {
                'title': title, 'category': ['约K','聚餐','出游'][i],
                'location': ['日音 KTV · 中央店','巷口的小食堂','河滨公园'][i],
                'starts_at': start.isoformat(), 'deadline': (start-timedelta(hours=1)).isoformat(),
                'duration_hours': 3, 'capacity': 12, 'description': '带上喜欢的歌，周末见。',
                'join_owner': True, 'timezone': 'Asia/Taipei', 'minimum_participants': 0})
            assert status == 201, result
            roster_path = '/api/events/' + result['id'] + '/roster/'
            signup = {'people':[{'is_self':True}], 'queue_mode':'individual', 'intent':'registered'}
            status, preview = fixture.request(roster_path+'preview', 'POST', signup, client=other)
            assert status == 200, preview
            status, joined = fixture.request(roster_path+'parties', 'POST', {**signup, **preview, 'accept_partial':True}, client=other)
            assert status == 200, joined
        names = ['J-POP','摇滚','动画音乐','Vocaloid','电子','米津玄師','ヨルシカ',
                 'ずっと真夜中でいいのに。','宇多田ヒカル','藤井風','Aimer','YOASOBI',
                 '椎名林檎','Eve','星野源','King Gnu','サカナクション','Vaundy']
        service.upstream.data['entries'] = {
            'e'+str(i+1): {'id':'e'+str(i+1), 'text':name, 'category':'歌手' if i>4 else '领域',
                          'kind':'sub' if i>4 else 'main', 'createdBy':'10001',
                          'createdAt':int(datetime.now(timezone.utc).timestamp())}
            for i, name in enumerate(names)}
        for j, member in enumerate(service.upstream.data['members'].values()):
            member['selection'] = [{'id':key,'level':3} for i,key in enumerate(service.upstream.data['entries']) if i%3==j%3]
            member.update(note='最近在循环这些歌。', notePublic=True)
        service.upstream.WALLS_DIR = str(fixture.folder/'walls')
        service.upstream.WALLS_MANIFEST = str(fixture.folder/'walls'/'manifest.json')
        service.upstream.save()
        jar = next(h.cookiejar for h in fixture.client.opener.handlers if hasattr(h,'cookiejar'))
        Path(sys.argv[1]).write_text(json.dumps({
            'base':fixture.base,
            'cookies':[{'name':c.name,'value':c.value,'url':fixture.base} for c in jar]}))
        stopped = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stopped.set())
        signal.signal(signal.SIGINT, lambda *_: stopped.set())
        print('READY', flush=True)
        stopped.wait()
    finally:
        fixture.doCleanups()
        MusicTests.tearDownClass()


if __name__ == '__main__':
    main()
