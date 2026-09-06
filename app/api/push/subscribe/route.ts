import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hashSecret, pool } from '@/lib/server-db';

const schema=z.object({
  deviceId:z.string().min(20), deviceSecret:z.string().min(32), timezone:z.string().min(1),
  subscription:z.object({endpoint:z.string().url(),expirationTime:z.number().nullable().optional(),keys:z.object({p256dh:z.string(),auth:z.string()})})
});

export async function POST(req:Request){
  try{
    if(!pool)return NextResponse.json({error:'DATABASE_URL não configurada'},{status:503});
    const body=schema.parse(await req.json());
    await pool.query(`insert into push_devices(device_id,secret_hash,timezone,subscription,active,updated_at)
      values($1,$2,$3,$4::jsonb,true,now())
      on conflict(device_id) do update set secret_hash=excluded.secret_hash,timezone=excluded.timezone,subscription=excluded.subscription,active=true,updated_at=now()`,
      [body.deviceId,hashSecret(body.deviceSecret),body.timezone,JSON.stringify(body.subscription)]);
    return NextResponse.json({ok:true});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Requisição inválida'},{status:400});}
}
