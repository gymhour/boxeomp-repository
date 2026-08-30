// ⚠️ SIN USO — handler serverless de Vercel. El backend corre en Railway, que ignora tanto
// `vercel.json` como esta carpeta `api/`. Este archivo NO se ejecuta ni se compila
// (tsconfig solo incluye `src/**/*`). Se conserva por las dudas.
//
// ⚠️ Además: este archivo YA ESTABA MUERTO antes de Railway. Nunca estuvo listado en los `crons`
// de `vercel.json` ni tuvo ruta que lo alcanzara, así que jamás llegó a ejecutarse.
// Tampoco valida CRON_SECRET: si alguna vez se reactiva, agregarle la protección primero.
//
// El scheduler real es el servicio 'cron' de Railway -> src/scripts/dailyCron.ts
// La lógica vigente vive en src/services/nightly.service.ts (marcarAusentes).
//
// ── Contenido original (Vercel) ────────────────────────────────────────────────
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

export default async function handler(req: any, res: any) {
  try {
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);
    ayer.setHours(23, 59, 59, 999);

    const { count } = await prisma.turno.updateMany({
      where: {
        estado: 'ACTIVO',
        fecha: { lte: ayer },
        Asistencias: { none: {} },
      },
      data: {
        estado: 'AUSENTE',
      },
    });

    res.status(200).json({ updated: count });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    await prisma.$disconnect();
  }
}
