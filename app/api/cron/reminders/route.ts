import { NextResponse } from 'next/server';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { pool } from '@/lib/server-db';
import { getWebPush } from '@/lib/push-server';

function inQuiet(now: Date, start: string, end: string) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

function quietEndUtc(nowUtc: Date, tz: string, start: string, end: string) {
  const local = toZonedTime(nowUtc, tz);
  const [eh, em] = end.split(':').map(Number);
  const target = new Date(local);
  target.setHours(eh, em, 0, 0);
  const [sh, sm] = start.split(':').map(Number);
  const startM = sh * 60 + sm;
  const endM = eh * 60 + em;
  const nowM = local.getHours() * 60 + local.getMinutes();
  if (startM >= endM && nowM >= startM) target.setDate(target.getDate() + 1);
  return fromZonedTime(target, tz);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV === 'production' && !secret) return NextResponse.json({ error: 'CRON_SECRET não configurado' }, { status: 503 });
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!pool) return NextResponse.json({ error: 'DATABASE_URL não configurada' }, { status: 503 });

  let push;
  try { push = getWebPush(); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'VAPID não configurado' }, { status: 503 }); }

  const client = await pool.connect();
  let jobs: any[] = [];
  try {
    await client.query('begin');
    const selected = await client.query(`
      select j.*, d.subscription, d.timezone, d.quiet_enabled, d.quiet_start, d.quiet_end
      from reminder_jobs j
      join push_devices d on d.device_id = j.device_id
      where j.active = true
        and d.active = true
        and j.next_notify_at <= now()
        and (j.locked_until is null or j.locked_until < now())
      order by j.next_notify_at asc
      for update of j skip locked
      limit 100
    `);
    jobs = selected.rows;
    for (const job of jobs) {
      await client.query(
        `update reminder_jobs set locked_until = now() + interval '2 minutes', updated_at = now() where device_id=$1 and occurrence_id=$2`,
        [job.device_id, job.occurrence_id]
      );
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    client.release();
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Cron selection error' }, { status: 500 });
  }
  client.release();

  let sent = 0;
  let failed = 0;

  for (const job of jobs) {
    const now = new Date();
    const timezone = job.timezone || 'UTC';

    if (job.quiet_enabled && inQuiet(toZonedTime(now, timezone), job.quiet_start, job.quiet_end)) {
      await pool.query(
        `update reminder_jobs set next_notify_at=$3, locked_until=null, updated_at=now() where device_id=$1 and occurrence_id=$2`,
        [job.device_id, job.occurrence_id, quietEndUtc(now, timezone, job.quiet_start, job.quiet_end)]
      );
      continue;
    }

    const overdue =
      (job.deadline_at && new Date(job.deadline_at) <= now) ||
      job.phase === 'deadline' ||
      job.phase === 'repeat';

    const payload = JSON.stringify({
      title: overdue ? '⚠️ Medicamento ainda não confirmado' : 'Hora do medicamento',
      body: overdue
        ? `Você ainda não marcou ${job.medication_label} como tomado.`
        : `Está na hora de ${job.medication_label}.`,
      tag: `med-${job.occurrence_id}`,
      url: job.url,
      requireInteraction: overdue,
      vibration: job.vibration,
      sound: job.sound
    });

    try {
      await push.sendNotification(job.subscription, payload, { TTL: 300 });
      sent++;

      if (job.phase === 'main' && !job.required) {
        await pool.query(
          `update reminder_jobs set active=false, phase='done', last_sent_at=now(), locked_until=null, updated_at=now() where device_id=$1 and occurrence_id=$2`,
          [job.device_id, job.occurrence_id]
        );
        continue;
      }

      let nextNotifyAt: Date;
      let nextPhase: 'deadline' | 'repeat';
      if (job.phase === 'main' && job.deadline_at && new Date(job.deadline_at) > now) {
        nextNotifyAt = new Date(job.deadline_at);
        nextPhase = 'deadline';
      } else {
        nextNotifyAt = new Date(now.getTime() + job.repeat_minutes * 60_000);
        nextPhase = 'repeat';
      }

      await pool.query(
        `update reminder_jobs set next_notify_at=$3, phase=$4, last_sent_at=now(), locked_until=null, updated_at=now() where device_id=$1 and occurrence_id=$2`,
        [job.device_id, job.occurrence_id, nextNotifyAt, nextPhase]
      );
    } catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await pool.query('update push_devices set active=false, updated_at=now() where device_id=$1', [job.device_id]);
        await pool.query('update reminder_jobs set locked_until=null, updated_at=now() where device_id=$1 and occurrence_id=$2', [job.device_id, job.occurrence_id]);
      } else {
        await pool.query(
          `update reminder_jobs set next_notify_at=now() + interval '5 minutes', locked_until=null, updated_at=now() where device_id=$1 and occurrence_id=$2`,
          [job.device_id, job.occurrence_id]
        );
      }
    }
  }

  return NextResponse.json({ ok: true, selected: jobs.length, sent, failed });
}
