import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertDevice, pool } from '@/lib/server-db';
const schema=z.object({deviceId:z.string(),deviceSecret:z.string()});
export async function POST(req:Request){try{if(!pool)return NextResponse.json({error:'Banco não configurado'},{status:503});const b=schema.parse(await req.json());await assertDevice(b.deviceId,b.deviceSecret);await pool.query('update push_devices set active=false,updated_at=now() where device_id=$1',[b.deviceId]);await pool.query('update reminder_jobs set active=false,updated_at=now() where device_id=$1',[b.deviceId]);return NextResponse.json({ok:true});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Erro'},{status:400});}}
