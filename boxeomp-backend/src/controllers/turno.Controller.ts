import { Request, Response } from "express";
import { respondUnexpected } from "../services/apiError.service.js";
import prismaHC from "../models/HorarioClase.js";
import prisma from "../models/Prisma.js";
import prismaUsu from "../models/User.js";
import {
  ACTIVE_TURNO_STATES,
  CUPO_UNAVAILABLE,
  CupoUnavailableReason,
  findActiveCuota,
  findTurnoSameDay,
  getArgentinaDate,
  isTurnoRuleError,
  resolveSlot,
  TurnoRuleError,
  validateCuotaPaymentForBooking,
  validateHorarioCupoAvailability,
  validatePeriodAvailability
} from "../services/accessRules.service.js";
import { isRetryableTransactionError, runSerializableTransaction } from "../services/transaction.service.js";

const parseWallClockDate = (value: any): Date => {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return new Date(value);
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return new Date(value);
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] ? Number(match[6]) : 0,
    0
  ));
};

// ————— Mensajes de error para el alumno —————
// Los turnos y los períodos de cuota se guardan como "hora de pared" en UTC: se leen con
// getUTC* para no correrlos un día/hora al formatearlos.

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const formatDiaYFecha = (date: Date): string => (
  `${DIAS_SEMANA[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`
);

const formatHoraTurno = (date: Date): string => (
  `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
);

// Mensajes cortos: el alumno acaba de elegir clase, día y hora, así que repetirle esos
// datos (y el nombre de su plan) no le aporta nada. Sólo el motivo y qué puede hacer.
const buildSinCuotaMessage = (): string => (
  "No tenés una cuota activa para esa fecha. Hablá con el administrador para renovar tu plan."
);

const buildSinSesionesMessage = (limit: number): string => (
  `Ya usaste ${limit === 1 ? "la sesión" : `las ${limit} sesiones`} de tu cuota. `
  + "Vas a poder reservar de nuevo cuando se renueve."
);

const buildTurnoMismoDiaMessage = (turnoExistente: any): string => {
  const fechaExistente = turnoExistente?.fecha ? new Date(turnoExistente.fecha) : null;
  const hora = fechaExistente && !isNaN(fechaExistente.getTime()) ? formatHoraTurno(fechaExistente) : null;

  return `Ya tenés un turno ese día${hora ? ` a las ${hora}` : ""}. `
    + "Solo podés reservar un turno por día: cancelalo desde \"Mis turnos\" si querés cambiar de horario.";
};

const buildSinCupoMessage = (motivo: CupoUnavailableReason): string => (
  motivo === CUPO_UNAVAILABLE.RESERVADO_TURNOS_FIJOS
    ? "Los lugares que quedan en ese horario están reservados para turnos fijos. Probá con otro día u horario."
    : "Ya no quedan lugares en ese horario. Probá con otro día u horario."
);

const parseTurnoDateQuery = (value: unknown): { date?: Date; isDateOnly: boolean; invalid: boolean } => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return { isDateOnly: false, invalid: false };
  }

  if (typeof rawValue !== "string") {
    return { isDateOnly: false, invalid: true };
  }

  const trimmed = rawValue.trim();
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const date = new Date(Date.UTC(
      Number(dateOnlyMatch[1]),
      Number(dateOnlyMatch[2]) - 1,
      Number(dateOnlyMatch[3]),
      0,
      0,
      0,
      0
    ));
    return { date, isDateOnly: true, invalid: Number.isNaN(date.getTime()) };
  }

  const date = new Date(trimmed);
  return { date, isDateOnly: false, invalid: Number.isNaN(date.getTime()) };
};

const addUtcDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const getAllTurnos = async (req: Request, res: Response): Promise<void> => {
  try {
    const fechaDesde = parseTurnoDateQuery(req.query.fechaDesde);
    const fechaHasta = parseTurnoDateQuery(req.query.fechaHasta);

    if (fechaDesde.invalid || fechaHasta.invalid) {
      res.status(400).json({ message: "Los filtros fechaDesde y fechaHasta deben ser fechas válidas" });
      return;
    }

    const fechaFilter: { gte?: Date; lt?: Date; lte?: Date } = {};
    if (fechaDesde.date) {
      fechaFilter.gte = fechaDesde.date;
    }
    if (fechaHasta.date) {
      if (fechaHasta.isDateOnly) {
        fechaFilter.lt = addUtcDays(fechaHasta.date, 1);
      } else {
        fechaFilter.lte = fechaHasta.date;
      }
    }

    if (fechaFilter.gte && (fechaFilter.lt || fechaFilter.lte)) {
      const hasta = fechaFilter.lt || fechaFilter.lte;
      if (hasta && fechaFilter.gte.getTime() >= hasta.getTime()) {
        res.status(400).json({ message: "fechaDesde debe ser anterior a fechaHasta" });
        return;
      }
    }

    const turnos = await prisma.turno.findMany({
      ...(Object.keys(fechaFilter).length > 0 ? { where: { fecha: fechaFilter } } : {}),
      include: {
        User: {
          select: {
            ID_Usuario: true,
            email: true,
            nombre: true,
            apellido: true,
          }
        }, // Información del usuario relacionado
        HorarioClase: {
          include: {
            Clase: true, // Información de la clase relacionada
          },
        },
      },
      orderBy: [
        { fecha: "asc" },
        { ID_HorarioClase: "asc" },
      ],
    });

    res.status(200).json(turnos);
  } catch (error: any) {
    respondUnexpected(res, error, "cargar los turnos");
  }
};

const createTurno = async (req: Request, res: Response): Promise<void> => {
  try {
    const { ID_HorarioClase, fecha } = req.body;
    // Ownership: un cliente sólo puede crear turnos para sí mismo.
    // Admin/entrenador pueden crear turnos para otros indicando ID_Usuario.
    const userTipo = String(req.user?.tipo || '').toLowerCase();
    const isAdmin = userTipo === 'admin';
    const isStaff = ['admin', 'entrenador'].includes(userTipo);
    const ID_Usuario = isStaff ? Number(req.body.ID_Usuario) : req.user?.ID_Usuario;
    const fechaUTC = getArgentinaDate();
    // Validar que los datos necesarios estén presentes
    if (!ID_Usuario || !ID_HorarioClase || !fecha) {
      res.status(400).json({ message: "Completá todos los campos obligatorios." });
      return;
    }

    // Verificar que el usuario exista
    const usuario = await prismaUsu.findUnique({
      where: { ID_Usuario },
    });
    if (!usuario) {
      res.status(404).json({ message: "No encontramos ese usuario." });
      return;
    }

    // Verificar que el horario exista
    const horario = await prismaHC.findUnique({
      where: { ID_HorarioClase },
      include: {
        Clase: true,
      },
    });

    if (!horario) {
      res.status(404).json({ message: "No encontramos ese horario." });
      return;
    }

    const fechaTurno = parseWallClockDate(fecha);
    const nuevoTurno = await runSerializableTransaction(async (tx) => {
      // El turno se escribe siempre sobre el horario vigente del slot: si el front mandó
      // un horario desactivado (slot fragmentado), se redirige al que está en uso.
      const slot = await resolveSlot(Number(ID_HorarioClase), tx);
      const ID_HorarioClaseDestino = slot.vigente.ID_HorarioClase;

      // La cuota tiene que cubrir la fecha del turno. El fallback por mes sólo aplica a
      // cuotas viejas sin período definido: si tienen fechaInicio/fechaFin, se respeta el rango.
      const cuotaActiva = await tx.cuota.findFirst({
        where: {
          ID_Usuario,
          fechaInicio: { lte: fechaTurno },
          fechaFin: { gte: fechaTurno },
        },
        include: { Plan: true },
        orderBy: { fechaInicio: "desc" },
      }) || await tx.cuota.findFirst({
        where: {
          ID_Usuario,
          mes: `${fechaTurno.getFullYear()}-${String(fechaTurno.getMonth() + 1).padStart(2, "0")}`,
          OR: [
            { fechaInicio: null },
            { fechaFin: null },
          ],
        },
        include: { Plan: true },
        orderBy: { vence: "desc" },
      });
      if (!cuotaActiva) {
        throw new TurnoRuleError("SIN_CUOTA_ACTIVA", buildSinCuotaMessage());
      }

      if (!isAdmin) {
        const pagoError = await validateCuotaPaymentForBooking(ID_Usuario, cuotaActiva, tx);
        if (pagoError) throw new TurnoRuleError("CUOTA_IMPAGA", pagoError);

        const sinSesiones = await validatePeriodAvailability(ID_Usuario, cuotaActiva, undefined, tx);
        if (sinSesiones) {
          throw new TurnoRuleError("SIN_SESIONES_DISPONIBLES", buildSinSesionesMessage(sinSesiones.limit));
        }

        const turnoMismoDia = await findTurnoSameDay(ID_Usuario, fechaTurno, undefined, tx);
        if (turnoMismoDia) {
          throw new TurnoRuleError("TURNO_MISMO_DIA", buildTurnoMismoDiaMessage(turnoMismoDia));
        }

        const horarioActual = await tx.horarioClase.findUnique({
          where: { ID_HorarioClase: ID_HorarioClaseDestino },
          select: { cupos: true },
        });
        if (!horarioActual) throw new Error("Horario no encontrado");

        const cupoError = await validateHorarioCupoAvailability(
          ID_HorarioClaseDestino,
          fechaTurno,
          horarioActual.cupos,
          {
            releaseFixedReservationForUserId: Number(ID_Usuario),
            client: tx,
            horarioIds: slot.horarioIds,
          },
        );
        if (cupoError) {
          throw new TurnoRuleError("SIN_CUPO", buildSinCupoMessage(cupoError));
        }
      }

      return tx.turno.create({
        data: {
          fecha: fechaTurno,
          estado: "ACTIVO",
          origen: req.body.origen || "MANUAL",
          ID_Usuario,
          ID_HorarioClase: ID_HorarioClaseDestino,
          ID_Cuota: cuotaActiva.ID_Cuota,
          fechaCreacion: fechaUTC,
        },
        include: {
          HorarioClase: {
            include: {
              Clase: true,
            },
          },
          User: { select: { ID_Usuario: true, email: true, nombre: true, apellido: true } },
        },
      });
    });

    res.status(201).json({ message: "Turno creado exitosamente", turno: nuevoTurno });
  } catch (error: any) {
    if (isRetryableTransactionError(error)) {
      res.status(409).json({
        message: "Alguien está reservando ese mismo horario en este momento. Esperá unos segundos y probá de nuevo.",
      });
      return;
    }
    // Regla de negocio: el motivo ya viene explicado para el alumno, se devuelve tal cual.
    if (isTurnoRuleError(error)) {
      res.status(400).json({ message: error.message, code: error.code });
      return;
    }
    respondUnexpected(res, error, "agendar el turno");
  }
};


const deleteTurno = async (req: Request, res: Response): Promise<void> => {
  try {
    const id_turno = parseInt(req.params.id);

    // Validar que se haya proporcionado el ID del turno
    if (!id_turno) {
      res.status(400).json({ message: "No pudimos identificar el turno. Actualizá la página e intentá de nuevo." });
      return;
    }

    const turno = await prisma.turno.findUnique({
      where: { id_turno: Number(id_turno) },
    });

    if (!turno) {
      res.status(404).json({ message: "No encontramos ese turno." });
      return;
    }

    // Ownership: un cliente sólo puede cancelar sus propios turnos.
    const userTipo = String(req.user?.tipo || '').toLowerCase();
    const isAdmin = userTipo === 'admin';
    const isStaff = ['admin', 'entrenador'].includes(userTipo);
    if (!isStaff && turno.ID_Usuario !== req.user?.ID_Usuario) {
      res.status(403).json({ message: "No tenés permiso para cancelar este turno" });
      return;
    }

    if (!isAdmin && turno.estado === 'ASISTIDO') {
      res.status(400).json({ message: "No se puede cancelar un turno que ya fue asistido" });
      return;
    }

    const now = getArgentinaDate();
    const fechaTurno = new Date(turno.fecha);
    const diffMs = fechaTurno.getTime() - now.getTime();
    if (!isAdmin && diffMs < 60 * 60 * 1000) {
      res.status(400).json({ message: "El turno solo puede cancelarse con al menos 1 hora de anticipación. Si necesitás resolverlo, hablá con el administrador." });
      return;
    }

    await prisma.turno.update({
      where: { id_turno: Number(id_turno) },
      data: {
        estado: "CANCELADO",
        canceladoEn: now
      }
    });

    res.status(200).json({ message: "Turno cancelado exitosamente" });
  } catch (error: any) {
    respondUnexpected(res, error, "cancelar el turno");
  }
};

const getTurnoById = async (req: Request, res: Response): Promise<void> => {
  try {
    const id_turno = parseInt(req.params.id);

    // Validar que se haya proporcionado el ID del turno
    if (!id_turno) {
      res.status(400).json({ message: "No pudimos identificar el turno. Actualizá la página e intentá de nuevo." });
      return;
    }

    // Buscar el turno por ID
    const turno = await prisma.turno.findUnique({
      where: { id_turno: Number(id_turno) },
      include: {
        User: {
          select: {
            ID_Usuario: true,
            email: true,
            nombre: true,
            apellido: true,
          }
        }, // Información del usuario relacionado
        HorarioClase: {
          include: {
            Clase: true, // Información de la clase relacionada
          },
        },
      },
    });

    // Verificar si el turno existe
    if (!turno) {
      res.status(404).json({ message: "No encontramos ese turno." });
      return;
    }

    res.status(200).json(turno);
  } catch (error: any) {
    respondUnexpected(res, error, "cargar el turno");
  }
};

const updateTurno = async (req: Request, res: Response): Promise<void> => {
  try {
    const id_turno = parseInt(req.params.id);
    const { fecha, estado, ID_HorarioClase, ID_Usuario } = req.body;

    // Validar si existe el turno
    const turnoExistente = await prisma.turno.findUnique({
      where: { id_turno: Number(id_turno) },
    });

    if (!turnoExistente) {
      res.status(404).json({ message: "No encontramos ese turno." });
      return;
    }

    const nextFecha = fecha ? parseWallClockDate(fecha) : turnoExistente.fecha;
    const nextUsuario = Number(ID_Usuario || turnoExistente.ID_Usuario);
    const nextHorarioClase = Number(ID_HorarioClase || turnoExistente.ID_HorarioClase);
    const nextEstado = estado || turnoExistente.estado;
    // Sólo se reubica el turno cuando el pedido cambia de horario (reprogramación).
    // Un cambio de estado (ASISTIDO/AUSENTE) no debe mover un turno histórico de registro.
    const reasignaHorario = ID_HorarioClase !== undefined && ID_HorarioClase !== null;
    const turnoActualizado = await runSerializableTransaction(async (tx) => {
      // Reprogramar sobre un horario desactivado (slot fragmentado) redirige al vigente.
      const slot = await resolveSlot(nextHorarioClase, tx);
      const ID_HorarioClaseDestino = reasignaHorario
        ? slot.vigente.ID_HorarioClase
        : turnoExistente.ID_HorarioClase;

      const cuotaActiva = await tx.cuota.findFirst({
        where: {
          ID_Usuario: nextUsuario,
          fechaInicio: { lte: nextFecha },
          fechaFin: { gte: nextFecha },
        },
        include: { Plan: true },
        orderBy: { fechaInicio: "desc" },
      }) || await tx.cuota.findFirst({
        where: {
          ID_Usuario: nextUsuario,
          mes: `${nextFecha.getFullYear()}-${String(nextFecha.getMonth() + 1).padStart(2, "0")}`,
        },
        include: { Plan: true },
        orderBy: { vence: "desc" },
      });
      if (!cuotaActiva) {
        throw new TurnoRuleError(
          "SIN_CUOTA_ACTIVA",
          `El alumno no tiene una cuota activa para el ${formatDiaYFecha(nextFecha)}.`,
        );
      }

      const sinSesiones = await validatePeriodAvailability(nextUsuario, cuotaActiva, id_turno, tx);
      if (sinSesiones) {
        throw new TurnoRuleError(
          "SIN_SESIONES_DISPONIBLES",
          `El alumno ya usó las ${sinSesiones.limit} sesión(es) de su cuota.`,
        );
      }

      const turnoMismoDia = await findTurnoSameDay(nextUsuario, nextFecha, id_turno, tx);
      if (turnoMismoDia) {
        throw new TurnoRuleError(
          "TURNO_MISMO_DIA",
          `El alumno ya tiene un turno el ${formatDiaYFecha(nextFecha)} a las ${formatHoraTurno(new Date(turnoMismoDia.fecha))}. Solo se permite un turno por día.`,
        );
      }

      if (ACTIVE_TURNO_STATES.includes(nextEstado)) {
        // La capacidad de la sesión es siempre la del horario vigente del slot, aunque el
        // turno quede registrado sobre un hermano desactivado.
        const horarioClase = await tx.horarioClase.findUnique({
          where: { ID_HorarioClase: slot.vigente.ID_HorarioClase },
        });

        const cupoError = horarioClase
          ? await validateHorarioCupoAvailability(
            slot.vigente.ID_HorarioClase,
            nextFecha,
            horarioClase.cupos,
            {
              excludeTurnoId: id_turno,
              releaseFixedReservationForUserId: nextUsuario,
              client: tx,
              horarioIds: slot.horarioIds,
            },
          )
          : null;
        if (cupoError) {
          throw new TurnoRuleError("SIN_CUPO", buildSinCupoMessage(cupoError));
        }
      }

      return tx.turno.update({
        where: { id_turno: Number(id_turno) },
        data: {
          fecha: nextFecha,
          estado,
          ID_HorarioClase: ID_HorarioClaseDestino,
          ID_Usuario: ID_Usuario || turnoExistente.ID_Usuario,
          ID_Cuota: cuotaActiva.ID_Cuota,
        },
        include: {
          User: { select: { ID_Usuario: true, email: true, nombre: true, apellido: true } },
          HorarioClase: {
            include: { Clase: true },
          },
        },
      });
    });

    res.status(200).json({
      message: "Turno actualizado exitosamente",
      turno: turnoActualizado,
    });
  } catch (error: any) {
    if (isRetryableTransactionError(error)) {
      res.status(409).json({ message: "El horario está siendo modificado por otra operación. Intentá nuevamente." });
      return;
    }
    if (isTurnoRuleError(error)) {
      res.status(400).json({ message: error.message, code: error.code });
      return;
    }
    respondUnexpected(res, error, "actualizar el turno");
  }
};

const getTurnosByUsuario = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = parseInt(req.params.idUsuario);

    // Validar que se haya pasado un ID de usuario válido
    if (isNaN(userId)) {
      res.status(400).json({ message: "No pudimos identificar al usuario. Actualizá la página e intentá de nuevo." });
      return;
    }

    // Ownership: un cliente sólo puede ver sus propios turnos.
    const isStaff = ['admin', 'entrenador'].includes(String(req.user?.tipo || '').toLowerCase());
    if (!isStaff && req.user?.ID_Usuario !== userId) {
      res.status(403).json({ message: "No tenés permiso para ver los turnos de otro usuario" });
      return;
    }

    // Buscar todos los turnos de ese usuario
    const turnos = await prisma.turno.findMany({
      where: { ID_Usuario: userId },
      include: {
        User: {
          select: {
            ID_Usuario: true,
            email: true,
            nombre: true,
            apellido: true,
          }
        },
        HorarioClase: {
          include: { Clase: true }
        }
      },
      orderBy: { fecha: 'asc' }  // opcional: ordenados por fecha
    });

    res.status(200).json({ turnos });
  } catch (error: any) {
    respondUnexpected(res, error, "cargar tus turnos");
  }
};

/* Borrado FÍSICO de un turno (solo admin, vía ruta). A diferencia de deleteTurno (cancelación
   lógica), elimina el registro definitivamente para liberar la sesión del período y el día.
   Solo aplica a turnos AUSENTE o CANCELADO: los ACTIVO se cancelan por el flujo normal y los
   ASISTIDO son historia real del alumno. */
const deleteTurnoFisico = async (req: Request, res: Response): Promise<void> => {
  try {
    const id_turno = parseInt(req.params.id, 10);
    if (!id_turno) {
      res.status(400).json({ message: "No pudimos identificar el turno. Actualizá la página e intentá de nuevo." });
      return;
    }

    const turno = await prisma.turno.findUnique({ where: { id_turno } });
    if (!turno) {
      res.status(404).json({ message: "No encontramos ese turno." });
      return;
    }

    if (!['AUSENTE', 'CANCELADO'].includes(turno.estado)) {
      res.status(400).json({
        message: "Solo se pueden eliminar físicamente turnos AUSENTES o CANCELADOS",
      });
      return;
    }

    await prisma.$transaction([
      // Desvincular asistencias por las dudas (no debería haber en AUSENTE/CANCELADO)
      prisma.asistencia.updateMany({ where: { ID_Turno: id_turno }, data: { ID_Turno: null } }),
      prisma.turno.delete({ where: { id_turno } }),
    ]);

    res.status(200).json({ ok: true, message: "Turno eliminado definitivamente" });
  } catch (error: any) {
    respondUnexpected(res, error, "eliminar el turno");
  }
};

export const turnoMethods = {
  createTurno,
  deleteTurno,
  deleteTurnoFisico,
  getTurnoById,
  getAllTurnos,
  updateTurno,
  getTurnosByUsuario
}
