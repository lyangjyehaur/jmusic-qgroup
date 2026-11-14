#!/usr/bin/env python3
"""Prepare a private music snapshot and unambiguous, active admin prelinks."""
import argparse
from collections import Counter
import json
from pathlib import Path
import secrets
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from music_site.identity_store import Store


def prepare(snapshot, active_users, destination):
    data=json.loads(Path(snapshot).read_text())
    active=set(json.loads(Path(active_users).read_text()))
    members=data['members']
    counts=Counter(str(m.get('boardUserId') or '').strip() for m in members.values() if str(m.get('boardUserId') or '').strip())
    destination=Path(destination)
    destination.mkdir(mode=0o700)
    accepted=[]; conflicts=[]; invalid=[]
    for qq,member in members.items():
        uid=str(member.get('boardUserId') or '').strip()
        if not uid: continue
        if counts[uid]!=1:
            conflicts.append({'qq':qq,'user_id':uid,'reason':'duplicate_user_id'})
        elif uid not in active:
            invalid.append({'qq':qq,'user_id':uid,'reason':'missing_or_closed_user'})
        else:
            accepted.append({'qq':qq,'user_id':uid})
    # The copied admin password is never a new site's administrative credential.
    data.setdefault('settings',{})['adminPasswordHash']=secrets.token_hex(32)
    private={ 'accepted':accepted,'conflicts':conflicts,'invalid':invalid }
    for name,value in (('data.json',data),('mapping-review.json',private)):
        path=destination/name;path.write_text(json.dumps(value,ensure_ascii=False,indent=1));path.chmod(0o600)
    store=Store(destination/'identity.sqlite3')
    store.import_prelinks(accepted)
    (destination/'identity.sqlite3').chmod(0o600)
    return dict(members=len(members),entries=len(data['entries']),prelinked=len(accepted),
                conflicting_records=len(conflicts),invalid_records=len(invalid),
                pinless=sum(not bool(m.get('pinHash')) for m in members.values()))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',required=True)
    parser.add_argument('--active-users',required=True)
    parser.add_argument('--destination',required=True)
    args=parser.parse_args()
    print(json.dumps(prepare(args.snapshot,args.active_users,args.destination)))
