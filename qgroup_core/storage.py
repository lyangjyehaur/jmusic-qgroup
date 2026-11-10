"""SQLite connections and repeatable, versioned migrations."""
import hashlib
import json
import secrets
import sqlite3

from .common import now
from . import unionids, bot_settings


def connect(path):
    db = sqlite3.connect(str(path), timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def initialize(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
            nickname TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
            title TEXT NOT NULL, category TEXT NOT NULL, location TEXT NOT NULL,
            starts_at TEXT NOT NULL, deadline TEXT NOT NULL, capacity INTEGER NOT NULL,
            description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL REFERENCES events(id),
            user_id TEXT NOT NULL REFERENCES users(id),
            note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
            UNIQUE(event_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS registrations_event ON registrations(event_id, id);
        CREATE INDEX IF NOT EXISTS events_start ON events(starts_at);
        CREATE TABLE IF NOT EXISTS settlements (
            event_id TEXT PRIMARY KEY REFERENCES events(id),
            total_cents INTEGER NOT NULL, headcount INTEGER NOT NULL,
            qr_image BLOB, updated_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
        );
        ''')
        # Existing events have no known duration; preserve them without inventing an end time.
        columns = {r['name'] for r in db.execute('PRAGMA table_info(events)')}
        if 'duration_hours' not in columns:
            db.execute('ALTER TABLE events ADD COLUMN duration_hours INTEGER')
        columns = {r['name'] for r in db.execute('PRAGMA table_info(settlements)')}
        if 'note' not in columns:
            db.execute("ALTER TABLE settlements ADD COLUMN note TEXT NOT NULL DEFAULT ''")
        db.executescript('''
        CREATE TABLE IF NOT EXISTS settlement_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL REFERENCES events(id), version INTEGER NOT NULL,
            total_cents INTEGER NOT NULL, headcount INTEGER NOT NULL,
            note TEXT NOT NULL, qr_image BLOB, updated_at TEXT NOT NULL,
            actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
            kind TEXT NOT NULL, changed_fields TEXT NOT NULL,
            UNIQUE(event_id, version)
        );
        CREATE TRIGGER IF NOT EXISTS settlement_history_no_update
            BEFORE UPDATE ON settlement_history BEGIN
            SELECT RAISE(ABORT, 'Settlement history is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS settlement_history_no_delete
            BEFORE DELETE ON settlement_history BEGIN
            SELECT RAISE(ABORT, 'Settlement history is append-only'); END;
        ''')
        # Older releases only kept the latest bill. Preserve that as a labeled baseline.
        db.execute('''INSERT INTO settlement_history
            (event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields)
            SELECT s.event_id,1,s.total_cents,s.headcount,s.note,s.qr_image,s.updated_at,
                e.owner_id,COALESCE(u.nickname,'发起者'),'baseline','[]'
            FROM settlements s JOIN events e ON e.id=s.event_id LEFT JOIN users u ON u.id=e.owner_id
            WHERE NOT EXISTS (SELECT 1 FROM settlement_history h WHERE h.event_id=s.event_id)''')


    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        migrate_roster(db)


def migrate_admin_roles(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=14').fetchone():return
    db.execute('''CREATE TABLE user_admin_roles(
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        is_admin INTEGER NOT NULL CHECK(is_admin IN (0,1)),
        revision INTEGER NOT NULL,updated_at TEXT NOT NULL)''')
    db.execute('''CREATE TABLE admin_role_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),
        actor_ref TEXT NOT NULL,before_value INTEGER NOT NULL,after_value INTEGER NOT NULL,
        revision INTEGER NOT NULL,created_at TEXT NOT NULL)''')
    for operation in ('UPDATE','DELETE'):
        db.execute('CREATE TRIGGER admin_role_history_no_'+operation.lower()+' BEFORE '+operation+
                   " ON admin_role_history BEGIN SELECT RAISE(ABORT,'Admin role history is append-only'); END")
    db.execute('INSERT INTO schema_migrations VALUES(14,?)',(now(),))


def migrate_roster(db):
    db.execute('''CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)''')
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=1').fetchone():
        migrate_activity(db)
        return
    additions = {'revision': 'INTEGER NOT NULL DEFAULT 0', 'withdrawal_deadline': 'TEXT',
        'visibility': "TEXT NOT NULL DEFAULT 'public'", 'invite_token': 'TEXT'}
    columns = {row['name'] for row in db.execute('PRAGMA table_info(events)')}
    for name, definition in additions.items():
        if name not in columns:
            db.execute('ALTER TABLE events ADD COLUMN ' + name + ' ' + definition)
    statements = [
        '''CREATE TABLE browser_sessions (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)''',
        '''CREATE TABLE event_access (
            event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id))''',
        '''CREATE TABLE roster_parties (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            event_id TEXT NOT NULL REFERENCES events(id), manager_id TEXT NOT NULL REFERENCES users(id),
            queue_mode TEXT NOT NULL CHECK(queue_mode IN ('individual','together')), created_at TEXT NOT NULL)''',
        '''CREATE TABLE attendees (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            event_id TEXT NOT NULL REFERENCES events(id), manager_id TEXT NOT NULL REFERENCES users(id),
            user_id TEXT REFERENCES users(id), party_id TEXT REFERENCES roster_parties(id),
            name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
            payer_kind TEXT NOT NULL CHECK(payer_kind IN ('self','manager')),
            status TEXT NOT NULL CHECK(status IN ('confirmed','waiting','tentative','invited','withdrawn')),
            withdrawal_requested INTEGER NOT NULL DEFAULT 0, withdrawal_reason TEXT NOT NULL DEFAULT '',
            invitation_token TEXT UNIQUE, legacy_registration_id INTEGER UNIQUE,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)''',
        '''CREATE UNIQUE INDEX attendee_account_active ON attendees(event_id,user_id)
            WHERE user_id IS NOT NULL AND status!='withdrawn' ''',
        'CREATE INDEX attendees_event ON attendees(event_id,status,seq)',
        '''CREATE TABLE event_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id),
            version INTEGER NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL,
            action TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
            reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(event_id,version))''',
        '''CREATE TRIGGER event_audit_no_update BEFORE UPDATE ON event_audit
            BEGIN SELECT RAISE(ABORT,'Event history is append-only'); END''',
        '''CREATE TRIGGER event_audit_no_delete BEFORE DELETE ON event_audit
            BEGIN SELECT RAISE(ABORT,'Event history is append-only'); END''',
        '''CREATE TABLE notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
            event_id TEXT NOT NULL REFERENCES events(id), kind TEXT NOT NULL,
            message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)''',
        'CREATE INDEX notifications_user ON notifications(user_id,read_at,id)',
        '''CREATE TABLE request_results (
            user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
            signature TEXT NOT NULL, response_json TEXT NOT NULL, response_status INTEGER NOT NULL,
            created_at TEXT NOT NULL, PRIMARY KEY(user_id,request_key))''',
    ]
    # Execute statements separately: executescript would commit an in-progress migration.
    for statement in statements:
        db.execute(statement)
    db.execute('INSERT INTO browser_sessions SELECT token_hash,id,created_at FROM users')
    for event in db.execute('SELECT * FROM events ORDER BY id').fetchall():
        db.execute('UPDATE events SET invite_token=? WHERE id=?', (secrets.token_urlsafe(24), event['id']))
        rows = db.execute('''SELECT r.*,u.nickname FROM registrations r JOIN users u ON u.id=r.user_id
            WHERE r.event_id=? ORDER BY r.id''', (event['id'],)).fetchall()
        for index, row in enumerate(rows):
            party_id = hashlib.sha256(('legacy-party:' + str(row['id'])).encode()).hexdigest()[:16]
            attendee_id = hashlib.sha256(('legacy-attendee:' + str(row['id'])).encode()).hexdigest()[:16]
            status = 'confirmed' if event['capacity'] == 0 or index < event['capacity'] else 'waiting'
            db.execute('INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,?,?,?)',
                (party_id,event['id'],row['user_id'],'individual',row['created_at']))
            db.execute('''INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,
                status,legacy_registration_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)''',
                (attendee_id,event['id'],row['user_id'],row['user_id'],party_id,row['nickname'],row['note'],
                 'self',status,row['id'],row['created_at'],row['created_at']))
            db.execute('INSERT OR IGNORE INTO event_access VALUES(?,?,?)', (event['id'],row['user_id'],now()))
    # Keep the original registrations as an immutable migration source, never a second write path.
    for operation in ('INSERT','UPDATE','DELETE'):
        db.execute('''CREATE TRIGGER registrations_legacy_no_%s BEFORE %s ON registrations
            BEGIN SELECT RAISE(ABORT,'Legacy registrations are read-only'); END''' % (operation.lower(),operation))
    db.execute('INSERT INTO schema_migrations VALUES(1,?)', (now(),))
    migrate_activity(db)


def migrate_activity(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=2').fetchone():
        migrate_settlements(db)
        return
    additions={'lifecycle':"TEXT NOT NULL DEFAULT 'scheduled'",'registration_open':'INTEGER NOT NULL DEFAULT 1',
        'actual_started_at':'TEXT','actual_ended_at':'TEXT','archived_at':'TEXT','timezone':'TEXT',
        'minimum_participants':'INTEGER NOT NULL DEFAULT 0','formation_state':"TEXT NOT NULL DEFAULT 'pending'",
        'conditions_version':'INTEGER NOT NULL DEFAULT 1','change_summary':"TEXT NOT NULL DEFAULT ''",
        'cancellation_reason':"TEXT NOT NULL DEFAULT ''",'fee_policy':"TEXT NOT NULL DEFAULT ''",'draft_join_owner':'INTEGER NOT NULL DEFAULT 0'}
    for name,definition in additions.items():
        db.execute('ALTER TABLE events ADD COLUMN '+name+' '+definition)
    for name,definition in {'accepted_conditions_version':'INTEGER','confirmation_state':"TEXT NOT NULL DEFAULT 'accepted'",
        'attendance':"TEXT NOT NULL DEFAULT 'unknown'",'attendance_note':"TEXT NOT NULL DEFAULT ''",'arrived_at':'TEXT','left_at':'TEXT'}.items():
        db.execute('ALTER TABLE attendees ADD COLUMN '+name+' '+definition)
    statements=[
        '''CREATE TABLE event_conditions(event_id TEXT NOT NULL REFERENCES events(id),version INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,summary TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL,
            PRIMARY KEY(event_id,version))''',
        '''CREATE TABLE attendee_consents(id INTEGER PRIMARY KEY AUTOINCREMENT,attendee_id TEXT NOT NULL REFERENCES attendees(id),
            event_id TEXT NOT NULL REFERENCES events(id),version INTEGER NOT NULL,decision TEXT NOT NULL,
            actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL)''',
        '''CREATE TABLE event_roles(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),
            user_id TEXT NOT NULL REFERENCES users(id),permissions_json TEXT NOT NULL,created_at TEXT NOT NULL,
            UNIQUE(event_id,user_id))''',
        '''CREATE TABLE management_invitations(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),token TEXT UNIQUE NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('cohost','transfer')),target_name TEXT NOT NULL,recipient_id TEXT REFERENCES users(id),
            permissions_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',initiator_id TEXT NOT NULL REFERENCES users(id),
            accepted_by TEXT REFERENCES users(id),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,accepted_at TEXT)'''
    ]
    for statement in statements:
        db.execute(statement)
    for table in ('event_conditions','attendee_consents'):
        for operation in ('UPDATE','DELETE'):
            db.execute('CREATE TRIGGER '+table+'_no_'+operation.lower()+' BEFORE '+operation+' ON '+table+
                " BEGIN SELECT RAISE(ABORT,'Arrangement history is append-only'); END")
    db.execute("UPDATE events SET registration_open=CASE WHEN status='open' THEN 1 ELSE 0 END")
    db.execute("UPDATE events SET lifecycle='ended' WHERE status='finished' OR EXISTS(SELECT 1 FROM settlements WHERE event_id=events.id)")
    db.execute("UPDATE events SET lifecycle='cancelled' WHERE status IN ('cancelled','deleted')")
    # Keep old columns and timestamps unchanged; unknown actual times and timezones stay unknown.
    from . import conditions
    for event in db.execute('SELECT * FROM events').fetchall():
        conditions.publish(db,event)
    db.execute("UPDATE attendees SET accepted_conditions_version=1 WHERE status!='invited'")
    db.execute('INSERT INTO schema_migrations VALUES(2,?)',(now(),))
    migrate_settlements(db)


def migrate_settlements(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=3').fetchone():
        migrate_finance(db)
        return
    db.execute('''CREATE TABLE settlement_details(event_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
        PRIMARY KEY(event_id,version),FOREIGN KEY(event_id,version) REFERENCES settlement_history(event_id,version))''')
    db.execute('''CREATE TABLE settlement_receipts(event_id TEXT NOT NULL,version INTEGER NOT NULL,item_id TEXT NOT NULL,image BLOB NOT NULL,
        PRIMARY KEY(event_id,version,item_id),FOREIGN KEY(event_id,version) REFERENCES settlement_details(event_id,version))''')
    for table in ('settlement_details','settlement_receipts'):
        for operation in ('UPDATE','DELETE'):
            db.execute('CREATE TRIGGER '+table+'_no_'+operation.lower()+' BEFORE '+operation+' ON '+table+
                " BEGIN SELECT RAISE(ABORT,'Settlement detail history is append-only'); END")
    db.execute('INSERT INTO schema_migrations VALUES(3,?)',(now(),))
    migrate_finance(db)


def migrate_finance(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=4').fetchone():
        migrate_identity(db)
        return
    statements=[
        '''CREATE TABLE finance_reports(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event_id TEXT NOT NULL REFERENCES events(id),
            reporter_id TEXT NOT NULL REFERENCES users(id),reporter_name TEXT NOT NULL,payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,UNIQUE(event_id,id))''',
        '''CREATE TABLE finance_report_actions(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,
            report_id TEXT NOT NULL UNIQUE,decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected','withdrawn')),
            actor_id TEXT NOT NULL REFERENCES users(id),actor_name TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,
            FOREIGN KEY(event_id,report_id) REFERENCES finance_reports(event_id,id))''',
        '''CREATE TABLE finance_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
            event_id TEXT NOT NULL REFERENCES events(id),kind TEXT NOT NULL,payload_json TEXT NOT NULL,
            occurred_at TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),actor_name TEXT NOT NULL,
            created_at TEXT NOT NULL,source_report_id TEXT UNIQUE,reversal_of TEXT UNIQUE,UNIQUE(event_id,id),
            FOREIGN KEY(event_id,source_report_id) REFERENCES finance_reports(event_id,id),
            FOREIGN KEY(event_id,reversal_of) REFERENCES finance_entries(event_id,id))''',
        'CREATE INDEX finance_entries_event ON finance_entries(event_id,seq)',
        'CREATE INDEX finance_reports_event ON finance_reports(event_id,created_at,id)'
    ]
    for statement in statements:db.execute(statement)
    for table in ('finance_reports','finance_report_actions','finance_entries'):
        for operation in ('UPDATE','DELETE'):
            db.execute('CREATE TRIGGER '+table+'_no_'+operation.lower()+' BEFORE '+operation+' ON '+table+
                " BEGIN SELECT RAISE(ABORT,'Finance history is append-only'); END")
    db.execute('INSERT INTO schema_migrations VALUES(4,?)',(now(),))

    migrate_identity(db)


def migrate_identity(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=5').fetchone():
        migrate_media(db)
        return
    statements=[
        """CREATE TABLE browser_accounts(token_hash TEXT NOT NULL REFERENCES browser_sessions(token_hash) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(token_hash,user_id))""",
        """CREATE TABLE device_links(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
            status TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,used_by TEXT)""",
        """CREATE TABLE account_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),
            action TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL)""",
        """CREATE TABLE attendee_claims(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),attendee_id TEXT NOT NULL REFERENCES attendees(id),
            token TEXT UNIQUE NOT NULL,issuer_id TEXT NOT NULL REFERENCES users(id),requester_id TEXT REFERENCES users(id),
            status TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT)""",
        """CREATE TABLE attendee_payment_origins(attendee_id TEXT PRIMARY KEY REFERENCES attendees(id),payer_id TEXT NOT NULL,
            payer_name TEXT NOT NULL,claimant_owns INTEGER NOT NULL,payer_user_id TEXT REFERENCES users(id))""",
        'CREATE INDEX attendee_claims_event ON attendee_claims(event_id,status)'
    ]
    for statement in statements:db.execute(statement)
    for table in ('account_audit','attendee_payment_origins'):
        for operation in ('UPDATE','DELETE'):
            db.execute('CREATE TRIGGER '+table+'_no_'+operation.lower()+' BEFORE '+operation+' ON '+table+
                " BEGIN SELECT RAISE(ABORT,'Identity history is append-only'); END")
    db.execute('INSERT INTO schema_migrations VALUES(5,?)',(now(),))

    migrate_media(db)


def migrate_media(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=6').fetchone():
        migrate_qq(db)
        return
    statements=[
        """CREATE TABLE image_assets(digest TEXT PRIMARY KEY,size INTEGER NOT NULL,mime TEXT NOT NULL,created_at TEXT NOT NULL)""",
        """CREATE TABLE user_payment_codes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
            kind TEXT NOT NULL CHECK(kind IN ('wechat','alipay','other')),name TEXT NOT NULL,digest TEXT NOT NULL REFERENCES image_assets(digest),
            created_at TEXT NOT NULL,archived_at TEXT)""",
        "CREATE INDEX user_payment_codes_owner ON user_payment_codes(user_id,archived_at)",
        """CREATE TABLE settlement_code_images(event_id TEXT NOT NULL,version INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('wechat','alipay','other')),name TEXT NOT NULL,digest TEXT NOT NULL REFERENCES image_assets(digest),
            PRIMARY KEY(event_id,version,kind),FOREIGN KEY(event_id,version) REFERENCES settlement_history(event_id,version))""",
        """CREATE TABLE settlement_receipt_images(event_id TEXT NOT NULL,version INTEGER NOT NULL,item_id TEXT NOT NULL,
            digest TEXT NOT NULL REFERENCES image_assets(digest),PRIMARY KEY(event_id,version,item_id),
            FOREIGN KEY(event_id,version) REFERENCES settlement_details(event_id,version))"""
    ]
    for statement in statements:db.execute(statement)
    for table in ('image_assets','settlement_code_images','settlement_receipt_images'):
        for operation in ('UPDATE','DELETE'):
            db.execute('CREATE TRIGGER '+table+'_no_'+operation.lower()+' BEFORE '+operation+' ON '+table+
                " BEGIN SELECT RAISE(ABORT,'Image references are append-only'); END")
    db.execute('INSERT INTO schema_migrations VALUES(6,?)',(now(),))
    migrate_qq(db)


def migrate_qq(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=7').fetchone():
        migrate_accounts(db)
        return
    db.execute('''CREATE TABLE qq_accounts(app_id TEXT NOT NULL,openid TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),nickname TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(app_id,openid),UNIQUE(app_id,user_id))''')
    db.execute('''CREATE TABLE qq_attempts(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),app_id TEXT NOT NULL,mode TEXT NOT NULL,
        status TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,openid TEXT,nickname TEXT)''')
    db.execute('CREATE INDEX qq_attempts_device ON qq_attempts(token_hash,created_at)')
    db.execute('INSERT INTO schema_migrations VALUES(7,?)',(now(),))
    migrate_accounts(db)


def migrate_accounts(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=8').fetchone():
        migrate_privacy(db)
        return
    statements=[
        '''CREATE TABLE external_identities(provider TEXT NOT NULL,client_id TEXT NOT NULL,subject TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id),display_name TEXT NOT NULL,created_at TEXT NOT NULL,
            PRIMARY KEY(provider,client_id,subject),UNIQUE(provider,client_id,user_id))''',
        '''CREATE TABLE visitor_sessions(token_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)''',
        '''CREATE TABLE login_attempts(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,user_id TEXT REFERENCES users(id),
            provider TEXT NOT NULL,app_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,
            expires_at TEXT NOT NULL,created_at TEXT NOT NULL,openid TEXT,nickname TEXT,return_path TEXT NOT NULL DEFAULT '/')''',
        'CREATE INDEX login_attempts_device ON login_attempts(token_hash,created_at)',
        '''CREATE TABLE auth_requests(token_hash TEXT NOT NULL,request_key TEXT NOT NULL,signature TEXT NOT NULL,
            response_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(token_hash,request_key))''',
        '''CREATE TABLE site_settings(id INTEGER PRIMARY KEY CHECK(id=1),allow_name_registration INTEGER NOT NULL DEFAULT 0 CHECK(allow_name_registration IN (0,1)),revision INTEGER NOT NULL DEFAULT 0)''',
        'INSERT INTO site_settings(id) VALUES(1)',
        '''CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY,credential_hash TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)''',
        '''CREATE TABLE admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,before_value INTEGER NOT NULL,after_value INTEGER NOT NULL,created_at TEXT NOT NULL)'''
    ]
    for statement in statements:db.execute(statement)
    db.execute("INSERT INTO external_identities SELECT 'qq',app_id,openid,user_id,nickname,created_at FROM qq_accounts")
    for operation in ('UPDATE','DELETE'):
        db.execute('CREATE TRIGGER admin_audit_no_'+operation.lower()+' BEFORE '+operation+" ON admin_audit BEGIN SELECT RAISE(ABORT,'Admin history is append-only'); END")
    db.execute('INSERT INTO schema_migrations VALUES(8,?)',(now(),))
    migrate_privacy(db)


def migrate_privacy(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=9').fetchone():
        migrate_bot(db)
        unionids.migrate(db)
        bot_settings.migrate(db)
        migrate_admin_roles(db)
        return
    db.execute("ALTER TABLE login_attempts ADD COLUMN privacy_version TEXT NOT NULL DEFAULT ''")
    db.execute("ALTER TABLE login_attempts ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''")
    db.execute('''CREATE TABLE external_profiles(provider TEXT NOT NULL,client_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
        avatar_url TEXT NOT NULL,PRIMARY KEY(provider,client_id,user_id))''')
    db.execute('''CREATE TABLE privacy_consents(user_id TEXT PRIMARY KEY REFERENCES users(id),version TEXT NOT NULL,accepted_at TEXT NOT NULL)''')
    db.execute('''CREATE TABLE privacy_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,note TEXT NOT NULL DEFAULT '')''')
    db.execute('DROP TRIGGER image_assets_no_delete')
    db.execute('''CREATE TRIGGER image_assets_no_delete BEFORE DELETE ON image_assets
        WHEN EXISTS(SELECT 1 FROM user_payment_codes WHERE digest=OLD.digest)
          OR EXISTS(SELECT 1 FROM settlement_code_images WHERE digest=OLD.digest)
          OR EXISTS(SELECT 1 FROM settlement_receipt_images WHERE digest=OLD.digest)
        BEGIN SELECT RAISE(ABORT,'Referenced images cannot be deleted'); END''')
    db.execute('INSERT INTO schema_migrations VALUES(9,?)',(now(),))
    migrate_bot(db)
    unionids.migrate(db)
    bot_settings.migrate(db)
    migrate_admin_roles(db)


def migrate_bot(db):
    """QQ group bot outbox. Queued in the same transaction as the business write."""
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=10').fetchone():
        migrate_bot_delivery(db)
        return
    db.execute('''CREATE TABLE IF NOT EXISTS bot_outbox(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES events(id),
        kind TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'group' CHECK(channel IN ('group','private')),
        target TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        due_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','sending','sent','failed','skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE(event_id,kind,dedupe_key,channel,target))''')
    db.execute('CREATE INDEX IF NOT EXISTS bot_outbox_due ON bot_outbox(status,due_at,id)')
    db.execute('CREATE INDEX IF NOT EXISTS bot_outbox_event ON bot_outbox(event_id,created_at)')
    # The queue row describes a committed fact; only delivery state may change.
    db.execute('''CREATE TRIGGER IF NOT EXISTS bot_outbox_payload_immutable
        BEFORE UPDATE ON bot_outbox
        WHEN NEW.event_id!=OLD.event_id OR NEW.kind!=OLD.kind
          OR NEW.dedupe_key!=OLD.dedupe_key OR NEW.channel!=OLD.channel
          OR NEW.payload_json!=OLD.payload_json
          OR NEW.due_at!=OLD.due_at OR NEW.created_at!=OLD.created_at
        BEGIN SELECT RAISE(ABORT,'Outbox payload is immutable'); END''')
    db.execute('INSERT OR IGNORE INTO schema_migrations VALUES(10,?)',(now(),))
    migrate_bot_delivery(db)


def migrate_bot_delivery(db):
    """Explicit group sharing and separate immutable intent / delivery state."""
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=11').fetchone():return
    if 'bot_enabled' not in {r['name'] for r in db.execute('PRAGMA table_info(events)')}:
        db.execute('ALTER TABLE events ADD COLUMN bot_enabled INTEGER NOT NULL DEFAULT 0 CHECK(bot_enabled IN (0,1))')
    columns = {r['name'] for r in db.execute('PRAGMA table_info(bot_outbox)')}
    for column in ('retry_at TEXT', 'simulated_at TEXT', 'delivered_payload_json TEXT',
                   "claim_token TEXT NOT NULL DEFAULT ''", 'recipient_user_id TEXT REFERENCES users(id)'):
        if column.split()[0] not in columns:
            db.execute('ALTER TABLE bot_outbox ADD COLUMN '+column)
    db.execute('INSERT INTO schema_migrations VALUES(11,?)',(now(),))
