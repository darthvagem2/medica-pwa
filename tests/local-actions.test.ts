import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { confirmTaken, deleteMedication, updateMedication } from '@/lib/local-actions';
import { cancelOccurrenceReminder } from '@/lib/reminder-client';
import type { Medication } from '@/lib/types';

const normal: Medication = {
  id: 'normal', name: 'Losartana', dosage: 50, unit: 'mg', enabled: true, period: 'morning',
  schedules: [{ time: '08:00', deadline: '09:00' }], frequency: { type: 'daily', startDate: '2026-09-01' },
  reminders: { enabled: true, repeatMinutes: 30, sound: true, required: true }, createdAt: '2026-09-01', updatedAt: '2026-09-01'
};

beforeEach(async () => {
  await db.delete(); await db.open(); await db.medications.put(structuredClone(normal));
});

describe('medicamento normal e persistência', () => {
  it('confirma uma ocorrência e impede duplicação pelo mesmo id', async () => {
    await confirmTaken('normal', '2026-09-06', '08:00');
    await confirmTaken('normal', '2026-09-06', '08:00');
    expect(await db.logs.count()).toBe(1);
    expect((await db.logs.toArray())[0].status).toBe('taken');
  });

  it('persiste após fechar e reabrir o IndexedDB', async () => {
    await confirmTaken('normal', '2026-09-06', '08:00');
    db.close(); await db.open();
    expect((await db.logs.get('normal__2026-09-06__08:00'))?.status).toBe('taken');
  });

  it('alterar horário realmente edita o cadastro', async () => {
    await updateMedication('normal', { schedules: [{ time: '07:30', deadline: '09:00' }] });
    expect((await db.medications.get('normal'))?.schedules[0].time).toBe('07:30');
  });

  it('remover medicamento preserva histórico já registrado', async () => {
    await confirmTaken('normal', '2026-09-06', '08:00');
    await deleteMedication('normal');
    expect(await db.medications.get('normal')).toBeUndefined();
    expect(await db.logs.count()).toBe(1);
  });

  it('cancelamento chama o endpoint da ocorrência correta', async () => {
    await db.device.put({ id:'device', deviceId:'device-12345678901234567890', deviceSecret:'x'.repeat(64), timezone:'America/Sao_Paulo', pushSubscribed:true });
    const fetchMock = vi.fn().mockResolvedValue({ ok:true });
    vi.stubGlobal('fetch', fetchMock);
    await cancelOccurrenceReminder('normal__2026-09-06__08:00');
    expect(fetchMock).toHaveBeenCalledWith('/api/reminders/cancel', expect.objectContaining({ method:'POST' }));
    expect(fetchMock.mock.calls[0][1].body).toContain('normal__2026-09-06__08:00');
    vi.unstubAllGlobals();
  });
});
