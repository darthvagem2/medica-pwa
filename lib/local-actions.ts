'use client';

import { db } from './db';
import { combineLocalDateTime, localDateKey, medicationOccursOn, nextRotationSide, occurrenceId, statusForOccurrence } from './domain';
import type { Medication, MedicationLog, Side } from './types';

export async function createMedication(input: Omit<Medication, 'id' | 'createdAt' | 'updatedAt'>) {
  const now = new Date().toISOString();
  const medication: Medication = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  await db.medications.add(medication);
  return medication;
}

export async function updateMedication(id: string, patch: Partial<Medication>) {
  await db.medications.update(id, { ...patch, updatedAt: new Date().toISOString() });
}

export async function duplicateMedication(id: string) {
  const medication = await db.medications.get(id);
  if (!medication) throw new Error('Medicamento não encontrado');
  const now = new Date().toISOString();
  const clone: Medication = {
    ...structuredClone(medication),
    id: crypto.randomUUID(),
    name: `${medication.name} (cópia)`,
    createdAt: now,
    updatedAt: now
  };
  await db.medications.add(clone);
  return clone;
}

export async function deleteMedication(id: string) {
  await db.medications.delete(id);
}

export async function ensureLog(medication: Medication, dateKey: string, time: string): Promise<MedicationLog> {
  const id = occurrenceId(medication.id, dateKey, time);
  let log = await db.logs.get(id);
  if (log) return log;
  const schedule = medication.schedules.find(s => s.time === time);
  const now = new Date().toISOString();
  const scheduledAt = combineLocalDateTime(dateKey, time);
  const deadlineAt = schedule?.deadline ? combineLocalDateTime(dateKey, schedule.deadline) : undefined;
  const isPastDay = dateKey < localDateKey();
  const status = isPastDay ? 'missed' : statusForOccurrence(scheduledAt, deadlineAt, undefined);
  log = {
    id,
    medicationId: medication.id,
    medicationName: medication.name,
    dosage: medication.dosage,
    unit: medication.unit,
    scheduledDate: dateKey,
    scheduledTime: time,
    deadline: schedule?.deadline,
    status,
    createdAt: now,
    updatedAt: now
  };
  await db.logs.add(log);
  return log;
}

export async function confirmTaken(medicationId: string, dateKey: string, time: string) {
  return db.transaction('rw', db.medications, db.logs, async () => {
    const medication = await db.medications.get(medicationId);
    if (!medication) throw new Error('Medicamento não encontrado');
    const id = occurrenceId(medicationId, dateKey, time);
    const existing = await db.logs.get(id);
    if (existing?.status === 'taken') return existing;

    const now = new Date().toISOString();
    const schedule = medication.schedules.find(s => s.time === time);
    const sideUsed = medication.applicationRotation?.enabled ? medication.applicationRotation.nextSide : undefined;
    const log: MedicationLog = {
      id,
      medicationId,
      medicationName: medication.name,
      dosage: medication.dosage,
      unit: medication.unit,
      scheduledDate: dateKey,
      scheduledTime: time,
      deadline: schedule?.deadline,
      status: 'taken',
      takenAt: now,
      applicationSide: sideUsed,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    await db.logs.put(log);
    if (sideUsed && medication.applicationRotation) {
      await db.medications.update(medication.id, {
        applicationRotation: {
          ...medication.applicationRotation,
          lastUsedSide: sideUsed,
          nextSide: nextRotationSide(sideUsed)
        },
        updatedAt: now
      });
    }
    return log;
  });
}

export async function undoTaken(medicationId: string, dateKey: string, time: string) {
  return db.transaction('rw', db.medications, db.logs, async () => {
    const medication = await db.medications.get(medicationId);
    const id = occurrenceId(medicationId, dateKey, time);
    const log = await db.logs.get(id);
    if (!medication || !log || log.status !== 'taken') return;

    const scheduledAt = combineLocalDateTime(dateKey, time);
    const deadlineAt = log.deadline ? combineLocalDateTime(dateKey, log.deadline) : undefined;
    const newStatus = statusForOccurrence(scheduledAt, deadlineAt, undefined);
    const now = new Date().toISOString();

    if (log.applicationSide && medication.applicationRotation?.enabled) {
      const takenLogs = await db.logs.where('medicationId').equals(medicationId)
        .filter(l => l.status === 'taken' && !!l.takenAt && l.id !== log.id)
        .toArray();
      const laterTaken = takenLogs.some(l => !!log.takenAt && l.takenAt! > log.takenAt!);
      if (!laterTaken) {
        const previous = takenLogs
          .filter(l => !!log.takenAt && l.takenAt! < log.takenAt!)
          .sort((a,b) => (b.takenAt || '').localeCompare(a.takenAt || ''))[0];
        await db.medications.update(medicationId, {
          applicationRotation: {
            ...medication.applicationRotation,
            nextSide: log.applicationSide,
            lastUsedSide: previous?.applicationSide
          },
          updatedAt: now
        });
      }
    }

    await db.logs.put({
      ...log,
      status: newStatus,
      takenAt: undefined,
      applicationSide: undefined,
      updatedAt: now
    });
  });
}

export async function setNextApplicationSide(medicationId: string, side: Side) {
  const medication = await db.medications.get(medicationId);
  if (!medication?.applicationRotation?.enabled) throw new Error('Alternância não configurada');
  await db.medications.update(medicationId, {
    applicationRotation: { ...medication.applicationRotation, nextSide: side },
    updatedAt: new Date().toISOString()
  });
}

export async function ensureLogsForDates(medications: Medication[], dates: Date[]) {
  for (const date of dates) {
    const key = localDateKey(date);
    if (key > localDateKey()) continue;
    for (const medication of medications) {
      if (!medicationOccursOn(medication, date)) continue;
      for (const schedule of medication.schedules) await ensureLog(medication, key, schedule.time);
    }
  }
}

export async function skipOccurrence(medicationId: string, dateKey: string, time: string) {
  const medication = await db.medications.get(medicationId);
  if (!medication) throw new Error('Medicamento não encontrado');
  const existing = await ensureLog(medication, dateKey, time);
  if (existing.status === 'taken') throw new Error('Desfaça a confirmação antes de ignorar.');
  await db.logs.put({ ...existing, status: 'skipped', takenAt: undefined, applicationSide: undefined, updatedAt: new Date().toISOString() });
}
