import express from 'express';
import { respondError } from '../services/apiError.service.js';
import { authServices } from '../services/auth.service.js';
import { getStationToken, isDeviceConnected } from '../services/device.service.js';

const deviceRoutes = express.Router();

// 1. Estado del módulo de puerta (diagnóstico para el panel de administración)
deviceRoutes.get(
  '/status',
  authServices.authenticateToken,
  authServices.isAdmin,
  (_req, res) => {
    res.status(200).json({ conectado: isDeviceConnected() });
  }
);

// 2. Token de estación de confianza: un admin lo pide UNA vez desde la PC kiosko/recepción y queda
//    guardado en ese navegador. Es un secreto: no-store para que no quede cacheado.
deviceRoutes.post(
  '/station-token',
  authServices.authenticateToken,
  authServices.isAdmin,
  (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const stationToken = getStationToken();
    if (!stationToken) {
      respondError(res, 503, 'La apertura desde estaciones no está configurada en el servidor (falta STATION_TOKEN).');
      return;
    }
    res.status(200).json({ stationToken });
  }
);

export default deviceRoutes;
