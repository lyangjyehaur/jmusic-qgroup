"""Explicit account administrator roles and bootstrap credential sessions."""
import hashlib
import os
import re
import secrets
from http import cookies
from . import accounts,identity,bot_settings
from .common import APIError,now

COOKIE='kanban_admin'


def session_hash(headers):
    try:
        jar=cookies.SimpleCookie(headers.get('Cookie',''))
        return hashlib.sha256(jar[COOKIE].value.encode()).hexdigest() if COOKIE in jar else ''
    except cookies.CookieError:return ''


def authority(db,headers):
    member_session=identity.session_hash(headers)
    member=db.execute('''SELECT u.id,r.revision FROM browser_sessions s
        JOIN users u ON u.id=s.user_id JOIN user_admin_roles r ON r.user_id=u.id
        WHERE s.token_hash=? AND r.is_admin=1
        AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)''',(member_session,)).fetchone()
    if member:
        # Bind CSRF to the current account and grant, including on account switches
        # that retain the browser cookie. Revocation is checked on every request.
        digest='account:'+member_session+':'+member['id']+':'+str(member['revision'])
        return dict(digest=digest,auth_method='account',user_id=member['id'])
    digest=session_hash(headers)
    row=db.execute('SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>?',(digest,now())).fetchone()
    if not row:raise APIError('请先登录管理后台',401)
    # Rotating the configured credential revokes old admin sessions immediately.
    configured=os.environ.get('KANBAN_ADMIN_KEY_HASH','')
    if not configured or not secrets.compare_digest(row['credential_hash'],configured):raise APIError('管理凭证已变更，请重新登录',401)
    return dict(digest=digest,auth_method='credential',user_id=None)


def session(db,headers):return authority(db,headers)['digest']


def csrf(digest):return hashlib.sha256(('kanban-admin-v1:'+digest).encode()).hexdigest()


def view(db,headers):
    from . import privacy
    access=authority(db,headers)
    return dict(authenticated=True,csrf=csrf(access['digest']),auth_method=access['auth_method'],current_user_id=access['user_id'],
                settings=accounts.settings(db),providers=accounts.providers(),privacy_requests=privacy.queue(db),bot=bot_settings.view(db))


def users(db,headers,query):
    session(db,headers)
    search=query.get('search',[''])[0].strip()
    try:offset=int(query.get('offset',['0'])[0])
    except (ValueError,TypeError):raise APIError('用户列表页码不正确')
    if offset<0 or len(search)>100:raise APIError('用户查询条件不正确')
    unionid=query.get('unionid',['all'])[0]
    has_qq="EXISTS(SELECT 1 FROM external_identities q WHERE q.user_id=u.id AND q.provider='qq')"
    missing="""EXISTS(SELECT 1 FROM external_identities q WHERE q.user_id=u.id AND q.provider='qq'
        AND NOT EXISTS(SELECT 1 FROM external_unionids x WHERE x.provider=q.provider AND x.client_id=q.client_id AND x.subject=q.subject))"""
    filters={'all':'1','bound':has_qq+' AND NOT '+missing,'missing':missing,'unbound':'NOT '+has_qq}
    if unionid not in filters:raise APIError('UnionID 筛选条件不正确')
    where='''NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)
        AND (?='' OR instr(lower(u.id),lower(?))>0 OR instr(lower(u.nickname),lower(?))>0
        OR EXISTS(SELECT 1 FROM external_identities e WHERE e.user_id=u.id AND instr(lower(e.display_name),lower(?))>0)
        OR EXISTS(SELECT 1 FROM admin_user_metadata m WHERE m.user_id=u.id
            AND (instr(lower(m.note),lower(?))>0 OR instr(m.manual_qq,?)>0)))'''
    where+=' AND ('+filters[unionid]+')'
    params=(search,)*6
    total=db.execute('SELECT count(*) FROM users u WHERE '+where,params).fetchone()[0]
    rows=db.execute('''SELECT u.id,u.nickname,u.created_at,COALESCE(r.is_admin,0) AS is_admin,
        COALESCE(r.revision,0) AS revision,COALESCE(m.note,'') AS note,
        COALESCE(m.manual_qq,'') AS manual_qq,COALESCE(m.revision,0) AS metadata_revision,
        m.updated_at AS metadata_updated_at FROM users u LEFT JOIN user_admin_roles r ON r.user_id=u.id
        LEFT JOIN admin_user_metadata m ON m.user_id=u.id
        WHERE '''+where+' ORDER BY u.created_at DESC,u.id LIMIT 20 OFFSET ?',(*params,offset)).fetchall()
    return dict(users=[dict(id=r['id'],nickname=r['nickname'],created_at=r['created_at'],is_admin=bool(r['is_admin']),
                           revision=r['revision'],identities=accounts.linked(db,r['id']),
                           note=r['note'],manual_qq=r['manual_qq'],metadata_revision=r['metadata_revision'],
                           metadata_updated_at=r['metadata_updated_at']) for r in rows],
                total=total,offset=offset,limit=20)


def set_role(db,access,data):
    uid=data.get('user_id');value=data.get('is_admin');revision=data.get('base_revision')
    if not isinstance(uid,str) or type(value) is not bool or type(revision) is not int:
        raise APIError('管理员设置格式不正确')
    if not db.execute('''SELECT 1 FROM users u WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)''',(uid,)).fetchone():
        raise APIError('账号不存在或已注销',404)
    if access['user_id']==uid and not value:raise APIError('不能撤销当前登录账号的管理员权限，请由其他管理员操作',403)
    current=db.execute('SELECT * FROM user_admin_roles WHERE user_id=?',(uid,)).fetchone()
    before=bool(current['is_admin']) if current else False
    if revision!=(current['revision'] if current else 0):raise APIError('该账号的权限已被修改，请重新载入后重试',409)
    if before!=value:
        stamp=now()
        db.execute('''INSERT INTO user_admin_roles VALUES(?,?,?,?) ON CONFLICT(user_id)
            DO UPDATE SET is_admin=excluded.is_admin,revision=excluded.revision,updated_at=excluded.updated_at''',
                   (uid,int(value),revision+1,stamp))
        actor='account:'+access['user_id'] if access['user_id'] else 'credential:'+access['digest']
        db.execute('''INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at)
            VALUES(?,?,?,?,?,?)''',(uid,actor,int(before),int(value),revision+1,stamp))
    return dict(ok=True)


def bot_view(db,headers):
    session(db,headers)
    return bot_settings.view(db)


def set_metadata(db,access,data):
    uid=data.get('user_id');note=data.get('note');qq=data.get('manual_qq');revision=data.get('base_revision')
    if not isinstance(uid,str) or not isinstance(note,str) or not isinstance(qq,str) or type(revision) is not int or revision<0:
        raise APIError('用户备注格式不正确')
    note=note.strip();qq=qq.strip()
    if len(note)>1000:raise APIError('内部备注最多 1000 字')
    if qq and not re.fullmatch(r'[1-9][0-9]{4,11}',qq):raise APIError('QQ 号须为 5 至 12 位数字，且不能以 0 开头')
    if not db.execute('''SELECT 1 FROM users u WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id)''',(uid,)).fetchone():
        raise APIError('账号不存在或已注销',404)
    current=db.execute('SELECT * FROM admin_user_metadata WHERE user_id=?',(uid,)).fetchone()
    if revision!=(current['revision'] if current else 0):raise APIError('该账号的备注或 QQ 号已被修改，请重新载入后重试',409)
    if qq and db.execute('SELECT 1 FROM admin_user_metadata WHERE manual_qq=? AND user_id!=?',(qq,uid)).fetchone():
        raise APIError('该 QQ 号已关联其他账号，请先核对并解除原关联',409)
    if (note,qq)!=((current['note'],current['manual_qq']) if current else ('','')):
        actor='account:'+access['user_id'] if access['user_id'] else 'credential:'+access['digest']
        db.execute('''INSERT INTO admin_user_metadata VALUES(?,?,?,?,?,?) ON CONFLICT(user_id)
            DO UPDATE SET note=excluded.note,manual_qq=excluded.manual_qq,revision=excluded.revision,
            updated_at=excluded.updated_at,updated_by=excluded.updated_by''',(uid,note,qq,revision+1,now(),actor))
    return dict(ok=True)


def login(db,data):
    configured=os.environ.get('KANBAN_ADMIN_KEY_HASH','')
    supplied=data.get('key')
    if not configured or not isinstance(supplied,str) or not 32<=len(supplied)<=256 or not secrets.compare_digest(hashlib.sha256(supplied.encode()).hexdigest(),configured):
        raise APIError('管理凭证不正确',401)
    token=secrets.token_urlsafe(32);digest=hashlib.sha256(token.encode()).hexdigest()
    db.execute('DELETE FROM admin_sessions WHERE expires_at<=?',(now(),))
    db.execute('INSERT INTO admin_sessions VALUES(?,?,?,?)',(digest,configured,identity.expires(60),now()))
    return dict(ok=True),token


def command(db,headers,path,data):
    access=authority(db,headers);digest=access['digest']
    if not secrets.compare_digest(headers.get('X-Kanban-Admin',''),csrf(digest)):raise APIError('管理页面已过期，请刷新后重试',403)
    if path=='/api/admin/logout':
        db.execute('DELETE FROM admin_sessions WHERE token_hash=?',(session_hash(headers),))
        if access['auth_method']=='account':
            from . import privacy
            privacy.logout(db,identity.session_hash(headers))
        return dict(ok=True,logout_account=access['auth_method']=='account'),''
    if path=='/api/admin/users':return set_role(db,access,data),None
    if path=='/api/admin/users/metadata':return set_metadata(db,access,data),None
    if path=='/api/admin/music-links':
        from . import music_admin
        return music_admin.change(db,access,data),None
    if path=='/api/admin/privacy-review':
        from . import privacy
        return privacy.review(db,data),None
    if path=='/api/admin/bot-preview':
        return bot_settings.preview(db,data),None
    if path in ('/api/admin/bot-settings','/api/admin/bot-revert'):
        return bot_settings.save(db,data,digest,revert=path.endswith('bot-revert')),None
    if path!='/api/admin/settings':raise APIError('管理操作不存在',404)
    value=data.get('allow_name_registration');revision=data.get('base_revision')
    if type(value) is not bool or type(revision) is not int:raise APIError('注册设置格式不正确')
    current=accounts.settings(db)
    if revision!=current['revision']:raise APIError('注册设置已被其他管理页面修改，请刷新后重试',409)
    if current['allow_name_registration']!=value:
        db.execute('UPDATE site_settings SET allow_name_registration=?,revision=revision+1 WHERE id=1',(int(value),))
        db.execute('INSERT INTO admin_audit(action,before_value,after_value,created_at) VALUES(?,?,?,?)',
                   ('name_registration',int(current['allow_name_registration']),int(value),now()))
    return dict(ok=True,settings=accounts.settings(db)),None
