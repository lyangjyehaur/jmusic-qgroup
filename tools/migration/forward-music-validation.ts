import {openDatabase} from '@qgroup/database';
import {importMusic,object,profileId,readIdentity,type ObjectValue} from './music-codec';
import {forwardRows,forwardEqual,type ForwardRow} from './forward-board-storage';
import {assertForwardIdentity,musicEqual,type ForwardMusicSources} from './forward-music-sources';
import type {DB} from '@qgroup/database';
import type {RollbackMusic} from './rollback-music';

/** Only a throw-away semantic validator. It is never a reconstructed native
 * image; importing a fresh model would discard native receipts and provenance. */
export function validateForwardMusicGraph(s:ForwardMusicSources,music:RollbackMusic,identity:DB){
  assertForwardIdentity(identity);
  const members=object(music.data.members,'merged music members'),seen=new Set<string>(),ids=new Set<string>();
  for(const key of music.keys){
    if(seen.has(key.legacyKey)||ids.has(key.profileId))throw Error('Forward profile key collision');seen.add(key.legacyKey);ids.add(key.profileId);
    const prior=s.native.keys.find(row=>row.legacyKey===key.legacyKey);
    if(prior){if(!musicEqual(prior,key))throw Error('Forward original profile mapping differs');}
    else if(key.mode!=='preserved'||key.profileId!==profileId(key.legacyKey)||key.erased)throw Error('Invalid new forward profile mapping');
  }
  if(music.keys.length!==s.native.keys.length+Object.keys(members).filter(key=>!s.native.keys.some(row=>row.legacyKey===key)).length||s.native.keys.some(key=>!music.keys.some(row=>musicEqual(row,key))))throw Error('Incomplete forward original profile mapping');
  for(const key of Object.keys(members))if(!seen.has(key)||music.keys.find(row=>row.legacyKey===key)?.erased)throw Error('Unmapped or erased forward member');
  const rows=readIdentity(identity);
  // Cross-table UNIQUE ownership and contacts are semantic constraints in the
  // old system. SQLite's individual indexes cannot catch these collisions.
  const owners=new Map<string,string>(),contacts=new Map<string,string>();
  for(const table of ['links','prelinks'] as const)for(const row of rows[table]!){
    const key=String(row.qq),owner=String(row.user_id);if(!owner||!Object.hasOwn(members,key))throw Error('Forward ownership requires a present member');
    const prior=owners.get(owner);if(prior&&prior!==key)throw Error('Conflicting forward effective music ownership');owners.set(owner,key);
    const other=rows[table==='links'?'prelinks':'links']!.find(item=>item.qq===key);if(other&&other.user_id!==owner)throw Error('Conflicting forward profile owners');
  }
  for(const [key,value] of Object.entries(members)){
    const member=object(value,'forward member'),owner=rows.links!.find(row=>row.qq===key)?.user_id??rows.prelinks!.find(row=>row.qq===key)?.user_id??'';
    const override=rows.link_overrides!.find(row=>row.qq===key);
    if(member.boardUserId!==owner||override&&override.user_id!==owner)throw Error('Forward JSON ownership disagrees with identity');
    const contact=/^\d{4,12}$/.test(key)?key:String(member.contactQQ??''),stored=rows.profile_contacts!.find(row=>row.qq===key);
    if(stored&&stored.number!==contact)throw Error('Forward contact disagrees with identity');
    if(contact){if(!/^\d{4,12}$/.test(contact)||contacts.has(contact))throw Error('Conflicting forward contact alias');contacts.set(contact,key);}
  }
  for(const row of rows.profile_contacts!)if(!Object.hasOwn(members,String(row.qq))&&row.number){const number=String(row.number);if(!/^\d{4,12}$/.test(number)||contacts.has(number))throw Error('Forward orphan contact reservation conflicts');contacts.set(number,String(row.qq));}
  for(const table of ['link_overrides','native_profiles'] as const)for(const row of rows[table]!)if(!Object.hasOwn(members,String(row.qq)))throw Error('Forward identity private profile has no member');
  const validation=openDatabase(':memory:');
  try{
    validation.pragma('foreign_keys=OFF');
    for(const table of ['users','external_identities','privacy_requests']){
      const maps=[s.board.baseline,s.board.native,s.board.old].map(db=>new Map([...forwardRows(db,table)].map(row=>[row.__forward_rowid__,row]))),all=new Set(maps.flatMap(map=>[...map.keys()]));
      const columns=(validation.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name),insert=validation.prepare(`INSERT INTO "${table}"(rowid,${columns.map(name=>'"'+name+'"').join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`);
      for(const id of all){const [base,native,old]=maps.map(map=>map.get(id));let wanted:ForwardRow|undefined;
        if(forwardEqual(old,base))wanted=native;else{if(!forwardEqual(native,base)&&!forwardEqual(native,old))throw Error('Forward board identity dependency conflict');wanted=old;}
        if(wanted)insert.run(id,...columns.map(column=>wanted![column]));
      }
    }
    // Native-only owners are checked against the real merged board identity;
    // closed accounts require the full erasure replay, not silent detachment.
    for(const owner of owners.keys())if(validation.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(owner))throw Error('Closed forward owner requires authority-backed account cleanup');
    importMusic(validation,music.data as ObjectValue,rows,new Map(),'2000-01-01T00:00:00.000Z');
    const normalized=validation.prepare('SELECT count(*) AS n FROM music_profiles').get() as {n:number};
    if(normalized.n!==Object.keys(members).length)throw Error('Forward source graph lost members');
  }finally{validation.close();}
}
