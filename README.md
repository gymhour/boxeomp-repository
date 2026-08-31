# BoxeoMP

Monorepo de la plataforma BoxeoMP.

```text
boxeomp/
├── boxeomp-backend/   API Node.js, Express, TypeScript y Prisma/MySQL
├── boxeomp-frontend/  Aplicación React
└── package.json       Workspaces y comandos del monorepo
```

## Instalación

Desde la raíz:

```bash
npm install
```

También se puede trabajar de manera independiente dentro de cada workspace.

## Desarrollo

```bash
npm run dev:backend
npm run dev:frontend
```

El backend utiliza `boxeomp-backend/.env`. El frontend puede utilizar
`boxeomp-frontend/.env` para variables locales. Ninguno de estos archivos se
versiona.

## Builds

```bash
npm run build
npm run build:backend
npm run build:frontend
```

## Configuración del frontend por cliente

La configuración visual y comercial está centralizada en
`boxeomp-frontend/src/setup.js`. Desde ese archivo se controlan:

- URL de la API (`REACT_APP_API_URL` puede sobrescribirla por ambiente).
- Nombre, título y descripción del cliente.
- Logo para tema oscuro y claro.
- Favicon, apple-touch icon y fondo de autenticación.
- Colores principales de la interfaz y de los reportes PDF.
- Titular de cuenta, alias, CBU/CUIL y WhatsApp para comprobantes.

Los componentes no deben importar logos del cliente directamente; deben tomar
los recursos desde `CLIENT_SETUP`.

## Base de datos

Para aplicar en producción las migraciones existentes de Prisma:

```bash
npm run migrate:deploy
```

El seed carga datos de prueba y solamente debe ejecutarse de forma intencional:

```bash
npm run seed
```

## Railway

El repositorio se despliega como un monorepo aislado. Cada servicio debe usar
el mismo repositorio de GitHub con una carpeta raíz diferente:

### API

- Root Directory: `/boxeomp-backend`
- Build Command: `npm ci && npm run build`
- Pre-deploy Command: `npm run migrate:deploy`
- Start Command: `npm start`
- Watch Path: `/boxeomp-backend/**`

### Frontend

- Root Directory: `/boxeomp-frontend`
- Build Command: `npm ci && npm run build`
- Watch Path: `/boxeomp-frontend/**`

La base MySQL es un servicio separado del mismo proyecto Railway. Las variables
de entorno se configuran por servicio; `DATABASE_URL` pertenece únicamente a la
API.
