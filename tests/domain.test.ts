import { describe, expect, it } from 'vitest';
import { buildOccurrences, medicationOccursOn, nextReminderAt, nextRotationSide, occurrenceId } from '@/lib/domain';
import type { Medication } from '@/lib/types';

const med:Medication={id:'m1',name:'Teste',dosage:10,unit:'mg',enabled:true,period:'morning',schedules:[{time:'08:00',deadline:'09:00'}],frequency:{type:'daily',startDate:'2026-09-01'},reminders:{enabled:true,repeatMinutes:30,sound:true,required:true},createdAt:'',updatedAt:''};

describe('ocorrências e lembretes',()=>{
  it('gera identificador único por medicamento/data/horário',()=>expect(occurrenceId('m','2026-09-06','08:00')).toBe('m__2026-09-06__08:00'));
  it('marca atraso depois do horário',()=>{const date=new Date(2026,8,6,10,0);const list=buildOccurrences([med],[],new Date(2026,8,6,12),date);expect(list[0].status).toBe('late')});
  it('após lembrete principal agenda deadline e depois repete 30 min',()=>{const now=new Date('2026-09-06T11:00:00Z');const deadline=new Date('2026-09-06T12:00:00Z');const a=nextReminderAt({now,scheduledAt:new Date('2026-09-06T10:00:00Z'),deadlineAt:deadline,repeatMinutes:30,phase:'main'});expect(a.at.toISOString()).toBe(deadline.toISOString());const b=nextReminderAt({now:deadline,scheduledAt:new Date('2026-09-06T10:00:00Z'),deadlineAt:deadline,repeatMinutes:30,phase:'deadline'});expect(b.at.toISOString()).toBe('2026-09-06T12:30:00.000Z')});
  it('alternância é estritamente esquerda/direita',()=>{expect(nextRotationSide('left')).toBe('right');expect(nextRotationSide('right')).toBe('left')});
  it('respeita dias específicos da semana',()=>{const m={...med,frequency:{type:'weekdays' as const,weekdays:[1,3,5]}};expect(medicationOccursOn(m,new Date(2026,8,7,12))).toBe(true);expect(medicationOccursOn(m,new Date(2026,8,8,12))).toBe(false)});
});
