import crypto from "crypto";
import { respondUnexpected } from "../services/apiError.service.js";
import { Request, Response } from "express";
import prisma from "../models/User.js";
import { authServices } from "../services/auth.service.js";
import { sendResetPasswordEmail, sendWelcomeEmail } from "../services/email.service.js";
import { comparePassword, hashPassword } from "../services/password.service.js";
//import { sendEmail } from "../services/mail"; // tu capa de envío de mail

const register = async (req: Request, res: Response): Promise<void> => {
  const {
    email,
    password,
    dni,
    nombre,
    apellido,
    profesion,
    direc,
    tel,
    tipo,
    fechaCumple,
    estado,
  } = req.body;

  try {
    if (!email) {
      res.status(400).json({ message: "Ingresá un email para crear la cuenta." });
      return;
    }
    if (!password) {
      res.status(400).json({ message: "Elegí una contraseña para crear la cuenta." });
      return;
    }

    const hashedPassword = await hashPassword(password);
    const user = await prisma.create({
      data: {
        email,
        dni: dni || null,
        nombre: nombre || null,
        apellido: apellido || null,
        direc: direc || null,
        password: hashedPassword,
        // El registro público SIEMPRE crea clientes. La asignación de roles
        // (admin/entrenador) sólo se hace por un endpoint protegido de admin.
        tipo: "cliente",
        profesion: profesion || null,
        fechaCumple: fechaCumple || null,
        tel: tel || null,
        estado: estado || null,
      },
    });

    try {
      await sendWelcomeEmail(user.email, user.nombre ?? "");
    } catch (mailError) {
      console.error("No se pudo enviar el email de bienvenida:", mailError);
    }
    const token = authServices.generateToken(user);
    res.status(201).json({ token });
  } catch (error: any) {
    if (error?.code === "P2002") {
      if (error?.meta?.target?.includes("email")) {
        res.status(409).json({ message: "Ya hay una cuenta registrada con ese email. Probá iniciar sesión." });
        return;
      }
      if (error?.meta?.target?.includes("dni")) {
        res.status(409).json({ message: "Ya hay una cuenta registrada con ese DNI. Probá iniciar sesión." });
        return;
      }
    }
    respondUnexpected(res, error, "crear tu cuenta");
  }
};

const TIMEZONE = process.env.TIMEZONE || "America/Argentina/Cordoba";

function getMonthDayFromDate(d: Date, timeZone = TIMEZONE) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const month = Number(parts.find(p => p.type === "month")!.value);
  const day = Number(parts.find(p => p.type === "day")!.value);
  return { month, day };
}

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  try {
    if (!email) {
      res.status(400).json({ message: "Escribí tu email para iniciar sesión." });
      return;
    }
    if (!password) {
      res.status(400).json({ message: "Escribí tu contraseña para iniciar sesión." });
      return;
    }

    const user = await prisma.findUnique({ where: { email } });
    if (!user) {
      res.status(404).json({ message: "No encontramos ninguna cuenta con ese email. Revisalo o pedile el alta al administrador." });
      return;
    }

    // Validar si el usuario está activo
    if (user.estado === false || user.estado === null) {
      res.status(403).json({ message: "Tu cuenta está inactiva. Hablá con el administrador para que la reactive." });
      return;
    }

    const passwordMatch = await comparePassword(password, user.password);
    if (!passwordMatch) {
      res.status(401).json({ message: "La contraseña no es correcta. Revisala e intentá de nuevo." });
      return;
    }

    const token = authServices.generateToken(user);

    // Determinar si hoy es su cumpleaños (según TIMEZONE)
    let isBirthday = false;
    if (user.fechaCumple) {
      try {
        // Para hoy: usa directamente el current timestamp con Intl para obtener local month/day
        const { month: curMonth, day: curDay } = getMonthDayFromDate(new Date(), TIMEZONE);

        // Para birthday: usa UTC methods para extraer month/day sin shift (asumiendo DB es local date)
        const fechaCumpleDate = new Date(user.fechaCumple);
        const birthMonth = fechaCumpleDate.getUTCMonth() + 1; // getUTCMonth() es 0-indexed
        const birthDay = fechaCumpleDate.getUTCDate();

        isBirthday = (curMonth === birthMonth && curDay === birthDay);
      } catch (err) {
        console.warn("Error calculando cumpleaños:", err);
        isBirthday = false;
      }
    }

    // Devolvemos token + flag isBirthday
    res.status(200).json({ token, isBirthday });
  } catch (error: any) {
    respondUnexpected(res, error, "iniciar sesión");
  }
};

const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ message: "Ingresá tu email." });
    return;
  }
  // Buscar usuario por email
  const user = await prisma.findUnique({ where: { email } });
  if (!user) {
    // Para no revelar si existe o no, respondé siempre 200
    res.json({ message: "Si ese email existe, recibirás instrucciones." });
    return;
  }

  // Generar token y expiración (15 minutos)
  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 15 * 60 * 1000);
  // Guardar token y expiración en la BD
  await prisma.update({
    where: { ID_Usuario: user.ID_Usuario },
    data: { resetToken: token, resetTokenExpiry: expiry },
  });
  // Construir URL de reset
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  // Enviar email (no bloqueante)
  try {
    await sendResetPasswordEmail(user.email, resetUrl);
  } catch (mailError) {
    console.error("Error enviando email de reset:", mailError);
    // No abortamos la respuesta por fallo en el mail
  }
  // Responder siempre 200 para no filtrar existencia
  res.json({ message: "Si ese email existe, recibirás instrucciones." });
};

const resetPassword = async (req: Request, res: Response): Promise<void> => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    res.status(400).json({ message: "El enlace no es válido. Pedí uno nuevo desde \"Olvidé mi contraseña\"." });
    return;
  }
  // Buscar usuario con token válido
  const user = await prisma.findFirst({
    where: {
      resetToken: token,
      resetTokenExpiry: { gt: new Date() }
    }
  });
  if (!user) {
    res.status(400).json({ message: "El enlace para cambiar la contraseña ya venció. Pedí uno nuevo desde \"Olvidé mi contraseña\"." });
    return;
  }
  // Hashear y actualizar
  const hash = await hashPassword(newPassword);
  await prisma.update({
    where: { ID_Usuario: user.ID_Usuario },
    data: {
      password: hash,
      resetToken: null,
      resetTokenExpiry: null
    }
  });
  res.json({ message: "Contraseña reseteada con éxito." });
  return;
};

export const changePassword = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ message: 'Necesitás iniciar sesión para hacer esto.' });
    return;
  }
  const userId = req.user.ID_Usuario;  // <-- TS sabe que ya no es undefined
  const { currentPassword, newPassword } = req.body;

  // 1. Validaciones básicas
  if (!currentPassword || !newPassword) {
    res.status(400).json({ message: "Completá tu contraseña actual y la nueva." });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ message: "La nueva contraseña tiene que tener al menos 8 caracteres." });
    return;
  }

  // 2. Buscar usuario y verificar contraseña actual
  const user = await prisma.findUnique({ where: { ID_Usuario: userId } });
  if (!user) {
    res.status(404).json({ message: "No encontramos ese usuario." });
    return;
  }
  const match = await comparePassword(currentPassword, user.password);
  if (!match) {
    res.status(401).json({ message: "La contraseña actual es incorrecta." });
    return;
  }

  // 3. Hashear y actualizar nueva contraseña
  const hashed = await hashPassword(newPassword);
  await prisma.update({
    where: { ID_Usuario: userId },
    data: { password: hashed }
  });

  // 4. (Opcional) invalidar tokens anteriores:
  //    Podés llevar un campo tokenVersion en el modelo User y subirlo aquí
  //    para que todos los JWT antiguos dejen de ser válidos.

  res.json({ message: "Contraseña cambiada exitosamente." });
};

export const authMethods = {
  register,
  login,
  forgotPassword,
  resetPassword,
  changePassword
}