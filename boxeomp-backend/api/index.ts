// ⚠️ SIN USO — shim serverless de Vercel: envolvía el app de Express para que corriera como
// función. El backend corre en Railway, que ignora tanto `vercel.json` como esta carpeta `api/`.
// Este archivo NO se ejecuta ni se compila (tsconfig solo incluye `src/**/*`).
// Se conserva por las dudas.
//
// En Railway el servicio web arranca `dist/app.js` directo, sin ningún wrapper.

// import app from '../src/app.js'
// export default app;
import type { Request, Response } from "express";
import app from "../dist/app.js";     // tu Express "app"

export default function handler(req: Request, res: Response) {
  return new Promise<void>((resolve, reject) => {
    app(req, res, (err?: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
