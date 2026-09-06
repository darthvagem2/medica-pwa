import { describe, expect, it } from 'vitest';
import { fromZonedTime } from 'date-fns-tz';
import { medicationOccursOn } from '@/lib/domain';
import type { Medication } from '@/lib/types';

const med: Medication = {
  id:'m', name:'Teste', dosage:1, unit:'dose', enabled:true, period:'morning', schedules:[{time:'08:00'}],
  frequency:{type:'interval',intervalDays:2,startDate:'2026-09-06'}, reminders:{enabled:true,repeatMinutes:30,sound:true,required:true}, createdAt:'', updatedAt:''
};

describe('mudança de data e fuso', () => {
  it('a cada 2 dias não cria ocorrência no dia intermediário', () => {
    expect(medicationOccursOn(med, new Date(2026,8,6,12))).toBe(true);
    expect(medicationOccursOn(med, new Date(2026,8,7,12))).toBe(false);
    expect(medicationOccursOn(med, new Date(2026,8,8,12))).toBe(true);
  });

  it('o mesmo horário local produz UTC diferente em fusos diferentes', () => {
    const saoPaulo = fromZonedTime('2026-09-06 08:00:00', 'America/Sao_Paulo');
    const lisbon = fromZonedTime('2026-09-06 08:00:00', 'Europe/Lisbon');
    expect(saoPaulo.toISOString()).not.toBe(lisbon.toISOString());
  });
});
