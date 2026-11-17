import { musicCodepointOrder, prepareMusicMatchStats, type MatchEntry, type MatchMember } from './music-matching';
/** Preserve the source's admission order: it breaks tied tag frequencies. */
export function musicCircles(members: readonly MatchMember[], entries: readonly MatchEntry[], minLink = 40) {
  const participating = members.filter(member => member.selections.length > 0), remaining = [...participating];
  const groups: MatchMember[][] = [], byId = new Map(entries.map(entry => [entry.id, entry]));
  const indices = new Map(participating.map((member, i) => [member.id, i]));
  const selections = participating.map(member => new Set(member.selections.map(pick => pick.entryId)));
  const stats = prepareMusicMatchStats(entries);
  const links = new Map<string, boolean>();
  const linked = (a: MatchMember, b: MatchMember) => {
    const ai = indices.get(a.id)!, bi = indices.get(b.id)!, key = Math.min(ai, bi) + ':' + Math.max(ai, bi);
    if (!links.has(key)) {
      // A positive threshold cannot connect disjoint selections. Keep admission order unchanged.
      const shared = a.selections.some(pick => selections[bi]!.has(pick.entryId));
      links.set(key, (minLink <= 0 || shared) && stats(a.selections, b.selections).score >= minLink);
    }
    return links.get(key)!;
  };
  while (remaining.length) {
    let seed = 0;
    for (let i = 1; i < remaining.length; i++) if (remaining[i]!.selections.length > remaining[seed]!.selections.length) seed = i;
    const group = [remaining.splice(seed, 1)[0]!];
    let changed = true;
    while (changed) {
      changed = false;
      for (const member of [...remaining]) if (group.some(other => linked(member, other))) {
        group.push(member); remaining.splice(remaining.indexOf(member), 1); changed = true;
      }
    }
    groups.push(group);
  }
  groups.sort((a, b) => b.length - a.length);
  const clusters = groups.filter(group => group.length >= 2).map(group => {
    const tags = new Map<string, { name: string; count: number; entries: { id: string; kind: 'main' | 'sub' }[] }>();
    for (const member of group) for (const pick of member.selections) {
      const entry = byId.get(pick.entryId); if (!entry) continue;
      const tag = tags.get(entry.name) ?? { name: entry.name, count: 0, entries: [] };
      tag.count++; if (!tag.entries.some(value => value.id === entry.id)) tag.entries.push({ id: entry.id, kind: entry.kind });
      tags.set(entry.name, tag);
    }
    return { size: group.length, members: group.map(({ id, name }) => ({ id, name })).sort((a, b) => musicCodepointOrder(a.name, b.name)),
      tags: [...tags.values()].sort((a, b) => b.count - a.count).slice(0, 6) };
  });
  const singleMembers = groups.filter(group => group.length === 1).map(group => {
    const member = group[0]!, picks = member.selections.flatMap(pick => { const entry = byId.get(pick.entryId); return entry ? [{ id: entry.id, name: entry.name, kind: entry.kind }] : []; });
    return { id: member.id, name: member.name, picks: picks.slice(0, 8), pickCount: picks.length };
  });
  return { minLink, clusters, membersWithSelection: participating.length, singles: singleMembers.length, singleMembers };
}
