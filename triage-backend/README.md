# TRIAGE GADUAI — backend real

Backend (Node/Express + PostgreSQL) que le da a TRIAGE GADUAI memoria real y sincronización
entre cualquier dispositivo: el mismo Timeline, los mismos usuarios y los mismos documentos
adjuntos, se vean desde el computador que se vean.

## Qué hay aquí

- `server.js` — API REST (colegios, usuarios, timeline, chat, alertas) + sirve el frontend.
- `public/index.html` — el mismo TRIAGE GADUAI, pero conectado a la API en vez de localStorage.
- `db/schema.sql` — se aplica solo al arrancar el servidor (no hace falta correrlo a mano).

## Desarrollo local (opcional)

```
npm install
export DATABASE_URL=postgres://usuario:clave@localhost:5432/triage
npm start
```

Abre `http://localhost:3000`.

## Desplegar en Render

1. Sube esta carpeta a un repositorio de GitHub (instrucciones abajo).
2. En Render: New → Postgres (o dile a Claude que lo cree con el conector de Render ya conectado).
3. New → Web Service, apuntando a este repo:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Variable de entorno `DATABASE_URL`: la "Internal Database URL" del Postgres creado.
4. Al primer arranque, el propio servidor crea las tablas (no hace falta correr nada más).

## Seguridad pendiente antes de vender esto a un colegio real

Esta es una primera versión funcional, no un backend "listo para producción" todavía:

- Las contraseñas se guardan en texto plano en la base de datos — falta hashearlas (bcrypt).
- La autenticación es por correo+clave en cada llamada, sin sesiones ni tokens — funciona,
  pero conviene migrar a JWT o cookies de sesión.
- No hay límite de tamaño total de documentos por colegio (solo 4MB por archivo).
- No hay panel para que el máster recupere su clave si la olvida.

Nada de esto bloquea probarlo con colegios piloto, pero sí antes de cobrar por el producto.
