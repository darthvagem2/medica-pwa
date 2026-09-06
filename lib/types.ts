export type Period = 'morning' | 'afternoon' | 'night' | 'custom';
export type MedicationStatus = 'pending' | 'taken' | 'late' | 'skipped' | 'missed';
export type Side = 'left' | 'right';

export interface MedicationSchedule {
  time: string;
  deadline?: string;
}

export interface MedicationFrequency {
  type: 'daily' | 'weekdays' | 'interval' | 'custom';
  weekdays?: number[];
  intervalDays?: number;
  customDates?: string[];
  startDate?: string;
  endDate?: string;
}

export interface MedicationReminders {
  enabled: boolean;
  repeatMinutes: number;
  sound: boolean;
  required: boolean;
}

export interface MedicationRotation {
  enabled: boolean;
  possibleSides: ['left', 'right'];
  nextSide: Side;
  lastUsedSide?: Side;
}

export interface Medication {
  id: string;
  name: string;
  nickname?: string;
  dosage: number | string;
  unit: string;
  enabled: boolean;
  period: Period;
  customPeriodLabel?: string;
  schedules: MedicationSchedule[];
  frequency: MedicationFrequency;
  reminders: MedicationReminders;
  applicationRotation?: MedicationRotation;
  createdAt: string;
  updatedAt: string;
}

export interface MedicationLog {
  id: string;
  medicationId: string;
  medicationName: string;
  dosage: number | string;
  unit: string;
  scheduledDate: string;
  scheduledTime: string;
  deadline?: string;
  status: MedicationStatus;
  takenAt?: string;
  applicationSide?: Side;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  id: 'settings';
  theme: 'system' | 'light' | 'dark';
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  repeatMinutes: 10 | 15 | 30 | 45 | 60;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  onboardingDone: boolean;
}

export interface DeviceState {
  id: 'device';
  deviceId: string;
  deviceSecret: string;
  timezone: string;
  pushSubscribed: boolean;
}

export interface Occurrence {
  id: string;
  medication: Medication;
  scheduledDate: string;
  scheduledTime: string;
  deadline?: string;
  scheduledAt: Date;
  deadlineAt?: Date;
  log?: MedicationLog;
  status: MedicationStatus;
}

export interface ReminderJobPayload {
  occurrenceId: string;
  medicationId: string;
  medicationLabel: string;
  scheduledAt: string;
  deadlineAt?: string;
  repeatMinutes: number;
  sound: boolean;
  vibration: boolean;
  required: boolean;
  url: string;
}
