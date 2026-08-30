import express from 'express';
import { ragAsk } from '../controllers/asistente.Controller.js';
import { authenticateToken } from '../services/auth.service.js';

const asistenteRoutes = express.Router();

asistenteRoutes.post("/prompt", authenticateToken, ragAsk);

export default asistenteRoutes;