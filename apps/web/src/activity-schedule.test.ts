import { describe,it,expect } from 'vitest';
import { eventStartValue,shiftCalendarDate,wallDate,wallToISO,schedulePreview } from './activity-schedule';
import { ActivityEditorDraft } from './activity-draft-record';
describe('retained activity calendar interaction',()=>{
  it('requires an explicit early-morning date and shifts calendar days across years',()=>{
    expect(()=>eventStartValue('2026-12-31','00:30','')).toThrow();
    expect(eventStartValue('2026-12-31','00:30','0')).toBe('2026-12-31T00:30');
    expect(eventStartValue('2026-12-31','00:30','1')).toBe('2027-01-01T00:30');
    expect(shiftCalendarDate('2024-02-28',1)).toBe('2024-02-29');
    expect(()=>shiftCalendarDate('2026-02-30',1)).toThrow();
    const preview=schedulePreview(new Date('2026-12-31T15:00:00Z'),new Date('2026-12-31T18:00:00Z'),'Asia/Shanghai');
    expect(preview.requiresConfirmation).toBe(true);expect(preview.text).toContain('2027');expect(preview.text).toContain('跨日');
  });
  it('preserves saved seconds and rejects invalid or ambiguous local times',()=>{
    expect(wallToISO('2026-12-12T14:30:25','Asia/Tokyo')).toBe('2026-12-12T05:30:25.000Z');
    expect(wallDate('2026-12-12T05:30:25Z','Asia/Tokyo')).toBe('2026-12-12T14:30:25');
    expect(wallToISO('2026-12-12T14:30','Asia/Shanghai')).toBe('2026-12-12T06:30:00.000Z');
    expect(()=>wallToISO('2026-02-30T18:00','Asia/Shanghai')).toThrow();
    expect(()=>wallToISO('2026-11-01T01:30','America/New_York')).toThrow();
    expect(()=>wallToISO('2026-03-08T02:30','America/New_York')).toThrow();
    expect(wallToISO('2026-03-08T03:30','America/New_York')).toBe('2026-03-08T07:30:00.000Z');
  });
  it('upgrades old fixed-offset drafts without changing pending values or flags',()=>{
    const values={title:'原稿',category:'约K',location:'地點',startsAt:'2026-12-12T06:30:25Z',deadline:'2026-12-12T09:30:25Z',capacity:0};
    const pending={kind:'create',key:crypto.randomUUID(),input:{values,publish:true,confirm:true,acceptConditions:true}};
    const raw={id:null,revision:0,form:{title:'原稿',category:'约K',location:'地點',startsAt:'2026-12-12T14:30:25',deadline:'2026-12-12T17:30:25',withdrawalDeadline:'',durationHours:'3',capacity:'0',minimumParticipants:'0',description:'',feePolicy:'',timezone:'Asia/Tokyo',visibility:'public',botEnabled:false,joinOwner:true},pending};
    const upgraded=ActivityEditorDraft.parse(raw);expect(upgraded.form).toMatchObject({eventDate:'2026-12-12',startTime:'15:30:25',deadline:'2026-12-12T18:30:25',botEnabled:false});
    expect(upgraded.pending).toMatchObject(pending);expect(ActivityEditorDraft.parse(upgraded)).toEqual(upgraded);
  });
});
