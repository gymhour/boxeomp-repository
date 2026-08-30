// Runner manual de las tareas programadas (crons), mientras no haya un scheduler activo.
//
// Reutiliza los servicios YA COMPILADOS en dist/, así que corre exactamente el mismo
// código que correría el cron. Requiere `npm run build` previo.
//
// Uso:
//   node prisma/runCron.js --tarea=<nombre>            -> PREVIEW: no escribe ni envía nada
//   node prisma/runCron.js --tarea=<nombre> --apply    -> ejecuta de verdad
//
// Tareas:
//   checkVencidas   Marca vencida=true en cuotas impagas cuyo vencimiento pasó. Solo DB.
//   marcarAusentes  Marca AUSENTE los turnos ACTIVOS pasados sin asistencia. Solo DB.
//   cumpleanos      ENVÍA MAILS de cumpleaños del día.
//   recordatorios   ENVÍA MAILS: turnos de hoy · cuota que vence en 3 días · inactividad 15 días.
//
// ⚠️  Las dos primeras son idempotentes: volver a correrlas no hace nada.
//     Las dos de mails NO lo son: cada corrida vuelve a enviar. Correr una sola vez por día.
//
// ⚠️  Los recordatorios calculan "hoy" en UTC. En Argentina (UTC-3) eso coincide con el día
//     local sólo ANTES de las 21:00. Más tarde mandarían los recordatorios del día siguiente.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const TAREA = (process.argv.find((a) => a.startsWith("--tarea=")) || "").split("=")[1];

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfTodayUTC = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

const TAREAS = ["checkVencidas", "marcarAusentes", "cumpleanos", "recordatorios"];

/* ---------------------------------------------------------------- previews */
/* Replican los filtros de los servicios para mostrar el alcance sin ejecutar.
   Si cambian nightly.service.ts o reminders.service.ts, revisar estos conteos. */

async function previewCheckVencidas() {
  const ahora = new Date();
  const cuotas = await prisma.cuota.findMany({
    where: { vence: { lt: ahora }, pagada: false, vencida: false },
    select: { ID_Cuota: true, mes: true, vence: true, User: { select: { nombre: true, apellido: true } } },
    orderBy: { vence: "asc" },
  });
  console.log(`Cuotas a marcar como vencidas: ${cuotas.length}`);
  for (const c of cuotas.slice(0, 20)) {
    const nombre = `${c.User?.nombre ?? ""} ${c.User?.apellido ?? ""}`.trim() || `cuota ${c.ID_Cuota}`;
    console.log(`   · ${nombre} · mes ${c.mes} · venció ${new Date(c.vence).toISOString().slice(0, 10)}`);
  }
  if (cuotas.length > 20) console.log(`   … y ${cuotas.length - 20} más`);
}

async function previewMarcarAusentes() {
  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  ayer.setHours(23, 59, 59, 999);
  const turnos = await prisma.turno.findMany({
    where: { estado: "ACTIVO", fecha: { lte: ayer }, Asistencias: { none: {} } },
    select: { id_turno: true, fecha: true, User: { select: { nombre: true, apellido: true } } },
    orderBy: { fecha: "asc" },
  });
  console.log(`Turnos a marcar AUSENTE: ${turnos.length}`);
  for (const t of turnos.slice(0, 20)) {
    const nombre = `${t.User?.nombre ?? ""} ${t.User?.apellido ?? ""}`.trim() || `turno ${t.id_turno}`;
    console.log(`   · ${nombre} · ${new Date(t.fecha).toISOString().slice(0, 16).replace("T", " ")}`);
  }
  if (turnos.length > 20) console.log(`   … y ${turnos.length - 20} más`);
}

async function previewCumpleanos() {
  const tz = process.env.TIMEZONE || "America/Argentina/Cordoba";
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "2-digit", day: "2-digit" });
  const partes = fmt.formatToParts(new Date());
  const mes = Number(partes.find((p) => p.type === "month").value);
  const dia = Number(partes.find((p) => p.type === "day").value);

  const usuarios = await prisma.user.findMany({
    where: { fechaCumple: { not: null } },
    select: { email: true, nombre: true, fechaCumple: true },
  });
  const cumplen = usuarios.filter((u) => {
    const f = new Date(u.fechaCumple);
    return f.getUTCMonth() + 1 === mes && f.getUTCDate() === dia;
  });
  console.log(`Hoy (${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}, ${tz}) cumplen: ${cumplen.length}`);
  for (const u of cumplen) console.log(`   · ${u.nombre ?? ""} <${u.email}>`);
}

async function previewRecordatorios() {
  const hoy = startOfTodayUTC();
  const manana = new Date(hoy.getTime() + DAY_MS);

  const turnos = await prisma.turno.findMany({
    where: { estado: "ACTIVO", fecha: { gte: hoy, lt: manana }, User: { is: { estado: true } } },
    select: { ID_Usuario: true, User: { select: { email: true, nombre: true } } },
  });
  const alumnosConTurno = new Set(turnos.map((t) => t.ID_Usuario));
  console.log(`1) Recordatorio de turno de hoy → ${alumnosConTurno.size} mail(s) (1 por alumno)`);

  const dia3 = new Date(hoy.getTime() + 3 * DAY_MS);
  const dia4 = new Date(hoy.getTime() + 4 * DAY_MS);
  const cuotas = await prisma.cuota.findMany({
    where: { pagada: false, vence: { gte: dia3, lt: dia4 }, User: { is: { estado: true } } },
    select: { mes: true, User: { select: { email: true, nombre: true } } },
  });
  console.log(`2) Cuota que vence en 3 días → ${cuotas.length} mail(s)`);
  for (const c of cuotas.slice(0, 10)) console.log(`   · ${c.User?.nombre ?? ""} <${c.User?.email}> · mes ${c.mes}`);

  const target = new Date(hoy.getTime() - 15 * DAY_MS);
  const targetEnd = new Date(target.getTime() + DAY_MS);
  const usuarios = await prisma.user.findMany({
    where: { estado: true, tipo: "cliente" },
    select: {
      email: true, nombre: true,
      Asistencias: { where: { permitido: true }, orderBy: { fechaIngreso: "desc" }, take: 1, select: { fechaIngreso: true } },
    },
  });
  const inactivos = usuarios.filter((u) => {
    const last = u.Asistencias[0]?.fechaIngreso;
    return last && u.email && last >= target && last < targetEnd;
  });
  console.log(`3) Inactividad de 15 días → ${inactivos.length} mail(s)`);
  for (const u of inactivos.slice(0, 10)) console.log(`   · ${u.nombre ?? ""} <${u.email}>`);

  const total = alumnosConTurno.size + cuotas.length + inactivos.length;
  console.log(`\nTOTAL DE MAILS QUE SE ENVIARÍAN: ${total}`);
}

/* ---------------------------------------------------------------- ejecución */

async function ejecutar(tarea) {
  if (tarea === "checkVencidas") {
    const { checkVencidas } = await import("../dist/services/nightly.service.js");
    console.log("cuotas marcadas vencidas:", await checkVencidas());
  } else if (tarea === "marcarAusentes") {
    const { marcarAusentes } = await import("../dist/services/nightly.service.js");
    console.log("turnos marcados AUSENTE:", await marcarAusentes());
  } else if (tarea === "cumpleanos") {
    const { sendBirthdayEmails } = await import("../dist/services/nightly.service.js");
    console.log("mails de cumpleaños enviados:", await sendBirthdayEmails());
  } else if (tarea === "recordatorios") {
    const { runReminderTasks } = await import("../dist/services/reminders.service.js");
    console.log("resultado:", await runReminderTasks());
  }
}

async function main() {
  if (!TAREAS.includes(TAREA)) {
    console.log("Falta --tarea. Opciones:\n  " + TAREAS.join("\n  "));
    console.log("\nEjemplo: node prisma/runCron.js --tarea=checkVencidas");
    process.exitCode = 1;
    return;
  }

  const mandaMails = TAREA === "cumpleanos" || TAREA === "recordatorios";
  const ahora = new Date();
  const horaArg = new Date(ahora.getTime() - 3 * 60 * 60 * 1000).getUTCHours();

  console.log(`${APPLY ? "⚙️   EJECUTANDO" : "🔍  PREVIEW (no escribe ni envía nada)"} · tarea: ${TAREA}`);
  console.log(`    hora Argentina aproximada: ${String(horaArg).padStart(2, "0")}:00\n`);

  if (TAREA === "recordatorios" && horaArg >= 21) {
    console.log("⚠️   Son más de las 21:00 en Argentina: 'hoy' en UTC ya es el día siguiente.");
    console.log("     Los recordatorios saldrían con el día equivocado. Mejor esperá a mañana.\n");
  }

  if (TAREA === "checkVencidas") await previewCheckVencidas();
  else if (TAREA === "marcarAusentes") await previewMarcarAusentes();
  else if (TAREA === "cumpleanos") await previewCumpleanos();
  else if (TAREA === "recordatorios") await previewRecordatorios();

  if (!APPLY) {
    console.log("\nPREVIEW: no se escribió ni se envió nada. Agregá --apply para ejecutar.");
    if (mandaMails) console.log("⚠️   Al aplicar se envían mails REALES. Esta tarea NO es idempotente: correrla dos veces duplica los envíos.");
    return;
  }

  console.log("\n── Ejecutando ──");
  await ejecutar(TAREA);
  console.log("\n✅ Listo.");
}

main()
  .catch((error) => {
    console.error("Error ejecutando la tarea:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
