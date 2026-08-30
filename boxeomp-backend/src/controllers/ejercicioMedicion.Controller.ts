import { Request, Response } from "express";
import { respondUnexpected } from "../services/apiError.service.js";
import prisma from "../models/Prisma.js";

// Crear un EjercicioMedicion
const createEjercicioMedicion = async (req: Request, res: Response): Promise<void> => {
  try {
    const { ID_Usuario, nombre, tipoMedicion } = req.body;

    // Validar datos obligatorios
    if (!ID_Usuario || !nombre || !tipoMedicion) {
      res.status(400).json({ message: "Completá todos los campos obligatorios." });
      return;
    }

    const ejercicio = await prisma.ejercicioMedicion.create({
      data: {
        ID_Usuario: Number(ID_Usuario),
        nombre,
        tipoMedicion,
      },
      include: {
        HistoricoEjercicios: true,
      },
    });

    res.status(201).json(ejercicio);
  } catch (error: any) {
    respondUnexpected(res, error, "crear la medición");
  }
};

// Obtener todos los EjerciciosMedicion (incluyendo su histórico)
const getAllEjerciciosMedicion = async (req: Request, res: Response): Promise<void> => {
  try {
    const ejercicios = await prisma.ejercicioMedicion.findMany({
      include: {
        HistoricoEjercicios: true,
      },
    });
    res.status(200).json(ejercicios);
  } catch (error: any) {
    respondUnexpected(res, error, "cargar las mediciones");
  }
};

// Obtener un EjercicioMedicion por ID (incluyendo su histórico)
const getEjercicioMedicionById = async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(req.params.id);
  try {
    const ejercicio = await prisma.ejercicioMedicion.findUnique({
      where: { ID_EjercicioMedicion: id },
      include: { HistoricoEjercicios: true },
    });

    if (!ejercicio) {
      res.status(404).json({ message: "No encontramos esa medición." });
      return;
    }

    res.status(200).json(ejercicio);
  } catch (error: any) {
    respondUnexpected(res, error, "cargar la medición");
  }
};

// Actualizar un EjercicioMedicion
const updateEjercicioMedicion = async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(req.params.id);
  const { nombre, tipoMedicion } = req.body;

  try {
    if (!nombre && !tipoMedicion) {
      res.status(400).json({ message: "No hay cambios para guardar." });
      return;
    }

    const updatedEjercicio = await prisma.ejercicioMedicion.update({
      where: { ID_EjercicioMedicion: id },
      data: {
        ...(nombre && { nombre }),
        ...(tipoMedicion && { tipoMedicion }),
      },
      include: { HistoricoEjercicios: true },
    });

    res.status(200).json(updatedEjercicio);
  } catch (error: any) {
    respondUnexpected(res, error, "actualizar la medición");
  }
};

// Eliminar un EjercicioMedicion
const deleteEjercicioMedicion = async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(req.params.id);

  try {
    await prisma.ejercicioMedicion.delete({
      where: { ID_EjercicioMedicion: id },
    });

    res.status(200).json({ message: `Ejercicio de medición ${id} eliminado` });
  } catch (error: any) {
    respondUnexpected(res, error, "eliminar la medición");
  }
};

const getMaxCantidadByEjercicioMedicion = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ message: "No pudimos identificar la medición. Actualizá la página e intentá de nuevo." });
      return;
    }

    // Usar la función aggregate para obtener el máximo valor de 'Cantidad'
    const result = await prisma.historicoEjercicio.aggregate({
      where: {
        ID_EjercicioMedicion: id,
      },
      _max: {
        Cantidad: true,
      },
    });

    // result._max.Cantidad contendrá el valor máximo o null si no hay registros
    res.status(200).json({ maxCantidad: result._max.Cantidad });
  } catch (error: any) {
    respondUnexpected(res, error, "cargar tus mediciones");
  }
};

const getEjerciciosMedicionByUsuario = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = parseInt(req.params.idUsuario);
    if (isNaN(userId)) {
      res.status(400).json({ message: "No pudimos identificar al usuario. Actualizá la página e intentá de nuevo." });
      return;
    }

    const ejercicios = await prisma.ejercicioMedicion.findMany({
      where: { ID_Usuario: userId },
      include: { HistoricoEjercicios: true }
    });

    res.status(200).json({ ejercicios });
  } catch (error: any) {
    respondUnexpected(res, error, "cargar tus mediciones");
  }
};


export const ejercicioMedicionMethods = {
  createEjercicioMedicion,
  getAllEjerciciosMedicion,
  getEjercicioMedicionById,
  updateEjercicioMedicion,
  deleteEjercicioMedicion,
  getMaxCantidadByEjercicioMedicion,
  getEjerciciosMedicionByUsuario
};
