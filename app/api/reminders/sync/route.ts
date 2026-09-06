import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertDevice, pool } from '@/lib/server-db';
const job=z.object({occurrenceId:z.string(),medicationId:z.string(),medicationLabel:z.string().max(120),scheduledAt:z.string().datetime(),deadlineAt:z.string().datetime().optional(),repeatMinutes:z.number().int().min(10).max(60),sound:z.boolean(),vibration:z.boolean(),required:z.boolean(),url:z.string()});
const schema=z.object({deviceId:z.string(),deviceSecret:z.string(),timezone:z.string(),quietHours:z.object({enabled:z.boolean(),start:z.string(),end:z.string()}).optional(),jobs:z.array(job).max(10000)});
export async function POST(req:Request){
  try{if(!pool)return NextResponse.json({error:'Banco não configurado'},{status:503});const b=schema.parse(await req.json());await assertDevice(b.deviceId,b.deviceSecret);
    const client=await pool.connect();try{await client.query('begin');
      await client.query(`update push_devices set timezone=$2,quiet_enabled=$3,quiet_start=$4,quiet_end=$5,updated_at=now() where device_id=$1`,[b.deviceId,b.timezone,b.quietHours?.enabled||false,b.quietHours?.start||'23:00',b.quietHours?.end||'07:00']);
      for(const j of b.jobs){
        await client.query(`insert into reminder_jobs(device_id,occurrence_id,medication_id,medication_label,scheduled_at,deadline_at,next_notify_at,repeat_minutes,phase,sound,vibration,required,url,active,updated_at)
          values($1,$2,$3,$4,$5,$6,$5,$7,'main',$8,$9,$10,$11,true,now())
          on conflict(device_id,occurrence_id) do update set medication_id=excluded.medication_id,medication_label=excluded.medication_label,
          next_notify_at=case when reminder_jobs.scheduled_at<>excluded.scheduled_at or reminder_jobs.deadline_at is distinct from excluded.deadline_at then excluded.scheduled_at else reminder_jobs.next_notify_at end,
          phase=case when reminder_jobs.scheduled_at<>excluded.scheduled_at or reminder_jobs.deadline_at is distinct from excluded.deadline_at then 'main' else reminder_jobs.phase end,
          scheduled_at=excluded.scheduled_at,deadline_at=excluded.deadline_at,repeat_minutes=excluded.repeat_minutes,sound=excluded.sound,vibration=excluded.vibration,required=excluded.required,url=excluded.url,
          active=case when reminder_jobs.phase='done' and reminder_jobs.scheduled_at=excluded.scheduled_at and reminder_jobs.deadline_at is not distinct from excluded.deadline_at then false else true end,updated_at=now()`,
          [b.deviceId,j.occurrenceId,j.medicationId,j.medicationLabel,j.scheduledAt,j.deadlineAt||null,j.repeatMinutes,j.sound,j.vibration,j.required,j.url]);
      }
      const ids=b.jobs.map(j=>j.occurrenceId);
      if(ids.length) await client.query(`update reminder_jobs set active=false,updated_at=now() where device_id=$1 and not (occurrence_id = any($2::text[]))`,[b.deviceId,ids]);
      else await client.query('update reminder_jobs set active=false,updated_at=now() where device_id=$1',[b.deviceId]);
      await client.query('commit');return NextResponse.json({ok:true,count:b.jobs.length});
    }catch(e){await client.query('rollback');throw e;}finally{client.release();}
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Erro'},{status:400});}
}
