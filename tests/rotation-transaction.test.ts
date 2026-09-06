import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { confirmTaken, undoTaken } from '@/lib/local-actions';
import type { Medication } from '@/lib/types';

const base:Medication={id:'pen',name:'Caneta',dosage:10,unit:'UI',enabled:true,period:'night',schedules:[{time:'21:00',deadline:'22:00'}],frequency:{type:'daily'},reminders:{enabled:true,repeatMinutes:30,sound:true,required:true},applicationRotation:{enabled:true,possibleSides:['left','right'],nextSide:'left'},createdAt:'2026-09-01',updatedAt:'2026-09-01'};

beforeEach(async()=>{await db.delete(); await db.open(); await db.medications.put(structuredClone(base));});

describe('caneta transacional',()=>{
  it('confirma esquerda e só então muda próximo para direita',async()=>{const log=await confirmTaken('pen','2026-09-06','21:00');expect(log.applicationSide).toBe('left');expect((await db.medications.get('pen'))?.applicationRotation?.nextSide).toBe('right')});
  it('duplo clique não cria dois registros nem alterna duas vezes',async()=>{await confirmTaken('pen','2026-09-06','21:00');await confirmTaken('pen','2026-09-06','21:00');expect(await db.logs.count()).toBe(1);expect((await db.medications.get('pen'))?.applicationRotation?.nextSide).toBe('right')});
  it('próxima confirmação usa direita e volta para esquerda',async()=>{await confirmTaken('pen','2026-09-06','21:00');const log=await confirmTaken('pen','2026-09-07','21:00');expect(log.applicationSide).toBe('right');expect((await db.medications.get('pen'))?.applicationRotation?.nextSide).toBe('left')});
  it('não confirmar não altera o lado',async()=>{expect((await db.medications.get('pen'))?.applicationRotation?.nextSide).toBe('left')});
  it('desfazer a confirmação mais recente restaura o lado',async()=>{await confirmTaken('pen','2026-09-06','21:00');await undoTaken('pen','2026-09-06','21:00');expect((await db.medications.get('pen'))?.applicationRotation?.nextSide).toBe('left')});
});
