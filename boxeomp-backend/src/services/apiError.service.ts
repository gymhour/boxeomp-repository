import { Prisma } from "@prisma/client";
import { Response } from "express";

/**
 * Respuestas de error uniformes para toda la API.
 *
 * Reglas de redacción (valen para admin y para alumno):
 *   - cortas y en una o dos frases;
 *   - dicen QUÉ pasó y, cuando se puede, QUÉ hacer;
 *   - nunca exponen detalles internos (stack, mensajes de Prisma, nombres de tablas).
 *
 * El detalle técnico se sigue registrando en el log del servidor, que es donde sirve.
 */

type PrismaErrorResponse = { status: number; message: string };

// Campos únicos del schema traducidos a algo que la persona reconozca.
const UNIQUE_FIELD_MESSAGES: Record<string, string> = {
  email: "Ya hay una cuenta registrada con ese email.",
  dni: "Ya hay una persona registrada con ese DNI.",
  nombre: "Ya existe un registro con ese nombre.",
};

const getUniqueConstraintMessage = (error: Prisma.PrismaClientKnownRequestError): string => {
  const target = error.meta?.target;
  const campos = Array.isArray(target) ? target.map(String) : [String(target ?? "")];

  for (const campo of campos) {
    const match = Object.keys(UNIQUE_FIELD_MESSAGES).find(key => campo.toLowerCase().includes(key));
    if (match) return UNIQUE_FIELD_MESSAGES[match];
  }

  return "Ya existe un registro con esos datos.";
};

/**
 * Traduce los errores conocidos de Prisma a una respuesta que la persona entiende. Sin
 * esto caían todos en el catch genérico y salían como "error del sistema", cuando en
 * realidad son situaciones normales: un email repetido, algo que ya se borró, un registro
 * que todavía está en uso.
 */
const mapPrismaError = (error: unknown): PrismaErrorResponse | null => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;

  switch (error.code) {
    case "P2002":
      return { status: 409, message: getUniqueConstraintMessage(error) };
    case "P2025":
      return {
        status: 404,
        message: "No encontramos el registro. Puede que se haya eliminado: actualizá la página y volvé a intentar.",
      };
    case "P2003":
      return {
        status: 409,
        message: "No se puede eliminar porque tiene información asociada. Eliminá primero lo que depende de este registro.",
      };
    case "P2000":
      return { status: 400, message: "Alguno de los datos que ingresaste es demasiado largo. Acortalo y probá de nuevo." };
    default:
      return null;
  }
};

/** Error controlado: la persona hizo algo que no se puede, y el mensaje ya se lo explica. */
export const respondError = (res: Response, status: number, message: string, extra?: Record<string, unknown>): void => {
  res.status(status).json({ message, ...(extra || {}) });
};

/**
 * Cierre de los `catch`. `accion` es lo que se estaba intentando hacer, en infinitivo y en
 * palabras de la persona ("cargar las cuotas", "guardar el gasto"), para que el mensaje
 * final diga algo concreto en lugar de "Error al obtener las cuotas".
 */
export const respondUnexpected = (res: Response, error: unknown, accion: string): void => {
  console.error(`[${accion}]`, error);

  const conocido = mapPrismaError(error);
  if (conocido) {
    res.status(conocido.status).json({ message: conocido.message });
    return;
  }

  res.status(500).json({
    message: `No pudimos ${accion}. Probá de nuevo en unos minutos.`,
  });
};
