import { differenceInCalendarDays, endOfDay, format, isAfter, isBefore, parse, parseISO, startOfDay } from 'date-fns';
import type { Medication, MedicationLog, MedicationStatus, Occurrence, Side } from './types';

export function occurrenceId(medicationId: string, date: string, time: string) {
  return `${medicationId}__${date}__${time}`;
}

export function localDateKey(date = new Date()) {
  return format(date, 'yyyy-MM-dd');
}

export function combineLocalDateTime(dateKey: string, time: string) {
  return parse(`${dateKey} ${time}`, 'yyyy-MM-dd HH:mm', new Date());
}

export function medicationOccursOn(medication: Medication, date: Date): boolean {
  if (!medication.enabled) return false;
  const key = localDateKey(date);
  const { frequency } = medication;
  if (frequency.startDate && isBefore(endOfDay(date), startOfDay(parseISO(frequency.startDate)))) return false;
  if (frequency.endDate && isAfter(startOfDay(date), endOfDay(parseISO(frequency.endDate)))) return false;

  switch (frequency.type) {
    case 'daily':
      return true;
    case 'weekdays':
      return (frequency.weekdays || []).includes(date.getDay());
    case 'interval': {
      if (!frequency.startDate) return true;
      const days = differenceInCalendarDays(startOfDay(date), startOfDay(parseISO(frequency.startDate)));
      return days >= 0 && days % Math.max(1, frequency.intervalDays || 1) === 0;
    }
    case 'custom':
      return (frequency.customDates || []).includes(key);
    default:
      return false;
  }
}

export function statusForOccurrence(scheduledAt: Date, deadlineAt: Date | undefined, log: MedicationLog | undefined, now = new Date()): MedicationStatus {
  if (log?.status === 'taken' || log?.status === 'skipped' || log?.status === 'missed') return log.status;
  if (now.getTime() < scheduledAt.getTime()) return 'pending';
  if (deadlineAt && now.getTime() >= deadlineAt.getTime()) return 'late';
  if (now.getTime() >= scheduledAt.getTime()) return 'late';
  return 'pending';
}

export function buildOccurrences(medications: Medication[], logs: MedicationLog[], date: Date, now = new Date()): Occurrence[] {
  const key = localDateKey(date);
  const logMap = new Map(logs.map(l => [l.id, l]));
  const result: Occurrence[] = [];

  for (const medication of medications) {
    if (!medicationOccursOn(medication, date)) continue;
    for (const schedule of medication.schedules) {
      const id = occurrenceId(medication.id, key, schedule.time);
      const log = logMap.get(id);
      const scheduledAt = combineLocalDateTime(key, schedule.time);
      const deadlineAt = schedule.deadline ? combineLocalDateTime(key, schedule.deadline) : undefined;
      result.push({
        id,
        medication,
        scheduledDate: key,
        scheduledTime: schedule.time,
        deadline: schedule.deadline,
        scheduledAt,
        deadlineAt,
        log,
        status: statusForOccurrence(scheduledAt, deadlineAt, log, now)
      });
    }
  }

  return result.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

export function nextRotationSide(side: Side): Side {
  return side === 'left' ? 'right' : 'left';
}

export function nextReminderAt(params: {
  now: Date;
  scheduledAt: Date;
  deadlineAt?: Date;
  repeatMinutes: number;
  phase: 'main' | 'deadline' | 'repeat';
}) {
  const { now, scheduledAt, deadlineAt, repeatMinutes, phase } = params;
  if (phase === 'main') {
    if (deadlineAt && deadlineAt.getTime() > now.getTime()) return { at: deadlineAt, phase: 'deadline' as const };
    return { at: new Date(Math.max(now.getTime(), scheduledAt.getTime()) + repeatMinutes * 60_000), phase: 'repeat' as const };
  }
  return { at: new Date(now.getTime() + repeatMinutes * 60_000), phase: 'repeat' as const };
}

export function minutesLate(scheduledAt: Date, takenAt?: string, now = new Date()) {
  const end = takenAt ? new Date(takenAt) : now;
  return Math.max(0, Math.floor((end.getTime() - scheduledAt.getTime()) / 60_000));
}
