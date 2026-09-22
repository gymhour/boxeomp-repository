// Gateway WebSocket del módulo de puerta (ESP32) + política de quién puede abrir la puerta.
//
// El ESP32 está detrás del router del gimnasio (no es alcanzable desde internet), así que mantiene una
// conexión SALIENTE y permanente contra esta API y le empujamos la orden de apertura.
//
// Seguridad:
// - El ESP32 se autentica con `Authorization: Bearer <DEVICE_TOKEN>` (nunca por URL: quedaría en logs).
// - Se valida en el `upgrade` HTTP, ANTES del handshake: sin token válido responde 401 y nunca se abre un
//   socket. Los navegadores no pueden setear ese header en un WebSocket.
// - Comparaciones de secretos en tiempo constante.
// - La puerta solo se abre si el check-in viene de una estación de confianza (X-Station-Token) o de staff
//   logueado. El check-in sigue siendo público (celulares por QR), pero eso no abre la puerta.
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import { getOptionalAuthUser } from './auth.service.js';

const DEVICE_PATH = '/device';
// Sin heartbeat quedan conexiones fantasma cuando se corta el WiFi del gimnasio.
const HEARTBEAT_MS = 30_000;
const MIN_TOKEN_LENGTH = 32;
// El ESP32 no manda datos (solo recibe órdenes y responde pings): techo bajo contra abuso de memoria.
const MAX_PAYLOAD_BYTES = 1024;
// Un ESP32 con token equivocado reintenta cada ~5 s: agrupamos los rechazos en 1 línea por minuto.
const REJECT_LOG_INTERVAL_MS = 60_000;
const STAFF_ROLES = new Set(['admin', 'entrenador']);

// Fail-closed: sin token (o demasiado corto) no se acepta ningún dispositivo / ninguna estación.
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? '';
const STATION_TOKEN = process.env.STATION_TOKEN ?? '';
const DEVICE_TOKEN_OK = DEVICE_TOKEN.length >= MIN_TOKEN_LENGTH;
const STATION_TOKEN_OK = STATION_TOKEN.length >= MIN_TOKEN_LENGTH;

type DeviceSocket = WebSocket & { isAlive?: boolean };

// Hay un solo dispositivo por deploy: alcanza con una variable de módulo (no hace falta un Map).
let deviceSocket: DeviceSocket | null = null;

let rejectedSinceLastLog = 0;
let lastRejectLogAt = 0;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

// Hashear ambos lados iguala el largo (timingSafeEqual lo exige) y no filtra la longitud del secreto.
const safeEqual = (candidate: string, expected: string): boolean =>
  timingSafeEqual(sha256(candidate), sha256(expected));

const extractBearerToken = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
};

// Solo para logs (x-forwarded-for es falsificable): nunca usar para decisiones de seguridad.
const clientIp = (req: IncomingMessage): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'desconocida';
};

const logRejection = (reason: string, req: IncomingMessage): void => {
  rejectedSinceLastLog += 1;
  const now = Date.now();
  if (now - lastRejectLogAt < REJECT_LOG_INTERVAL_MS) return;
  console.warn(
    `[device] Conexión rechazada (${reason}, IP ${clientIp(req)}). Rechazos desde el último aviso: ${rejectedSinceLastLog}.`
  );
  rejectedSinceLastLog = 0;
  lastRejectLogAt = now;
};

const rejectUpgrade = (socket: Duplex, status: 401 | 404): void => {
  const reason = status === 401 ? 'Unauthorized' : 'Not Found';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

export const isDeviceConnected = (): boolean =>
  deviceSocket !== null && deviceSocket.readyState === WebSocket.OPEN;

/** Token que se guarda en las PCs de confianza. null si no está configurado en el servidor. */
export const getStationToken = (): string | null => (STATION_TOKEN_OK ? STATION_TOKEN : null);

/**
 * Decide si un check-in permitido puede abrir la puerta física y devuelve el origen (para auditoría).
 * null = no abre. Solo abren:
 *  1) estaciones de confianza (PC kiosko/recepción) con X-Station-Token válido, o
 *  2) staff logueado (admin/entrenador) haciendo el ingreso desde el panel.
 */
export const resolveDoorTrigger = (req: Request): string | null => {
  const stationToken = req.get('x-station-token');
  if (stationToken) {
    if (STATION_TOKEN_OK && safeEqual(stationToken, STATION_TOKEN)) return 'estación de confianza';
    console.warn('[device] Check-in con X-Station-Token inválido: no se abre la puerta (¿token rotado? volvé a autorizar la PC).');
  }

  const user = getOptionalAuthUser(req);
  if (user && STAFF_ROLES.has(String(user.tipo ?? '').toLowerCase())) {
    return `staff (usuario ${user.ID_Usuario})`;
  }

  return null;
};

/**
 * Empuja la orden de apertura al ESP32. Devuelve true si se pudo encolar el envío.
 * Nunca lanza: un fallo acá no debe romper la respuesta HTTP del check-in.
 */
export const openDoor = (checkinId: number, origen: string): boolean => {
  const socket = deviceSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn(`[device] Check-in ${checkinId} (${origen}) habilitado para abrir, pero el módulo de puerta no está conectado.`);
    return false;
  }

  try {
    socket.send(JSON.stringify({ action: 'open', checkinId, ts: Date.now() }), (error) => {
      if (error) console.error(`[device] Falló el envío de apertura (checkin ${checkinId}):`, error.message);
    });
    console.log(`[device] Orden de apertura enviada (checkin ${checkinId}, origen: ${origen}).`);
    return true;
  } catch (error) {
    console.error(`[device] Error enviando la orden de apertura (checkin ${checkinId}):`, error);
    return false;
  }
};

/**
 * Monta el WebSocket del módulo de puerta sobre el MISMO servidor HTTP de Express (path /device).
 * Se llama una sola vez desde app.ts, antes del listen.
 */
export const initDeviceGateway = (server: Server): WebSocketServer => {
  // noServer: manejamos el upgrade a mano para autenticar ANTES de completar el handshake.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  if (!DEVICE_TOKEN_OK) {
    console.error(`[device] DEVICE_TOKEN ausente o con menos de ${MIN_TOKEN_LENGTH} caracteres: se rechazarán todas las conexiones del módulo de puerta.`);
  }
  if (!STATION_TOKEN_OK) {
    console.warn(`[device] STATION_TOKEN ausente o con menos de ${MIN_TOKEN_LENGTH} caracteres: ninguna PC podrá abrir la puerta (solo staff logueado).`);
  }

  server.on('upgrade', (req, socket, head) => {
    const onSocketError = (error: Error): void => {
      console.error('[device] Error de socket durante el upgrade:', error.message);
    };
    socket.on('error', onSocketError);

    try {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (pathname !== DEVICE_PATH) {
        rejectUpgrade(socket, 404);
        return;
      }

      const token = extractBearerToken(req);
      if (!token || !DEVICE_TOKEN_OK || !safeEqual(token, DEVICE_TOKEN)) {
        logRejection(token ? 'token inválido' : 'sin header Authorization Bearer', req);
        rejectUpgrade(socket, 401);
        return;
      }

      socket.removeListener('error', onSocketError);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (error) {
      // Una URL malformada u otro error inesperado nunca debe tirar abajo la API.
      console.error('[device] Error procesando el upgrade:', error);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: DeviceSocket, req: IncomingMessage) => {
    // Reconexión sucia (cortes de WiFi): nos quedamos con la conexión nueva y cortamos la anterior.
    if (deviceSocket && deviceSocket !== ws) {
      console.warn('[device] Llegó una conexión nueva con otra activa: se reemplaza la anterior.');
      deviceSocket.terminate();
    }

    deviceSocket = ws;
    ws.isAlive = true;
    console.log(`[device] Módulo de puerta conectado (IP ${clientIp(req)}).`);

    // Cualquier señal de vida lo marca vivo: pong a nuestro ping o ping propio del ESP32.
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('ping', () => { ws.isAlive = true; });

    ws.on('close', (code) => {
      if (deviceSocket !== ws) return; // era una conexión ya reemplazada
      deviceSocket = null;
      console.log(`[device] Módulo de puerta desconectado (código ${code}).`);
    });

    ws.on('error', (error) => {
      console.error('[device] Error en la conexión del dispositivo:', error.message);
    });
  });

  // Heartbeat ping/pong: corta las conexiones que no respondieron el ping anterior.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      const socket = client as DeviceSocket;
      if (socket.isAlive === false) {
        console.warn('[device] El módulo de puerta no respondió el heartbeat: se corta la conexión.');
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    });
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
};
