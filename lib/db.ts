'use client';

import Dexie, { type EntityTable } from 'dexie';
import type { AppSettings, DeviceState, Medication, MedicationLog } from './types';

class MedicaDB extends Dexie {
  medications!: EntityTable<Medication, 'id'>;
  logs!: EntityTable<MedicationLog, 'id'>;
  settings!: EntityTable<AppSettings, 'id'>;
  device!: EntityTable<DeviceState, 'id'>;

  constructor() {
    super('medica-pwa');
    this.version(1).stores({
      medications: 'id, enabled, period, updatedAt',
      logs: 'id, medicationId, scheduledDate, status, takenAt, [medicationId+scheduledDate]',
      settings: 'id',
      device: 'id'
    });
  }
}

export const db = new MedicaDB();

export const defaultSettings: AppSettings = {
  id: 'settings',
  theme: 'system',
  notificationsEnabled: true,
  soundEnabled: true,
  vibrationEnabled: true,
  repeatMinutes: 30,
  quietHoursEnabled: false,
  quietStart: '23:00',
  quietEnd: '07:00',
  onboardingDone: false
};

export async function ensureLocalState() {
  const settings = await db.settings.get('settings');
  if (!settings) await db.settings.put(defaultSettings);

  let device = await db.device.get('device');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!device) {
    device = {
      id: 'device',
      deviceId: crypto.randomUUID(),
      deviceSecret: crypto.randomUUID() + crypto.randomUUID(),
      timezone,
      pushSubscribed: false
    };
    await db.device.put(device);
  } else if (device.timezone !== timezone) {
    await db.device.update('device', { timezone });
  }
}
