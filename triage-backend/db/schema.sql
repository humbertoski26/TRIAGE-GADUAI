-- TRIAGE GADUAI · esquema de base de datos (Postgres)

create table if not exists colegios (
  id text primary key,
  nombre text not null,
  comuna text,
  relacionai_url text,           -- link al despliegue de Relacionai de este colegio (botón cruzado en el header)
  creado_en timestamptz not null default now()
);
alter table colegios add column if not exists relacionai_url text;
-- Insignia/logo propio del colegio (data URI base64), usado en documentos formales como la
-- ficha de Entrevista — si no está cargada, se usa el ícono genérico de GADUAI como respaldo.
alter table colegios add column if not exists insignia_data text;

create table if not exists usuarios (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  nombre text not null,
  correo text not null,
  clave text not null,
  perfil text not null,
  creado_en timestamptz not null default now(),
  unique (colegio_id, correo)
);
-- Preferencia de tema guardada por cuenta (no por dispositivo) — 'oscuro' por defecto para
-- no cambiar el aspecto de nadie hasta que alguien elija modo claro.
alter table usuarios add column if not exists tema text not null default 'oscuro';

create table if not exists items (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  tipo text not null,            -- 'tarea' | 'hito'
  triage text not null,          -- 'Rojo' | 'Azul' | 'Naranjo' | 'Gris'
  titulo text not null,
  descripcion text,
  fecha date not null,
  responsable text,
  copiados text[] default '{}',
  persona text not null,
  perfil text not null,
  creado text not null,
  revisado boolean not null default false,
  archivo_nombre text,
  archivo_data text,             -- data URL (base64), documento adjunto
  react jsonb not null default '{"like":0,"dislike":0,"ok":0,"heart":0,"done":false}',
  creado_en timestamptz not null default now()
);
create index if not exists items_colegio_idx on items(colegio_id);
-- Evita reenviar el aviso/correo de vencimiento cada vez que corre el cron diario.
alter table items add column if not exists recordatorio_enviado boolean not null default false;
-- Reemplaza recordatorio_enviado con 3 etapas (null -> '2dias' -> '1dia' -> 'hoy', nunca
-- retrocede) — permite avisar en 2 días, 1 día y el mismo día del vencimiento sin duplicar.
alter table items add column if not exists recordatorio_etapa text;
-- Círculo de la promesa (solo tipo='tarea'): nuevo -> dedo_arriba|dedo_abajo -> manito_ok -> cerrado.
alter table items add column if not exists circulo_estado text not null default 'nuevo';
alter table items add column if not exists circulo_like boolean not null default false;

-- Bitácora estructurada del círculo de la promesa (distinta del chat libre): un mensaje +
-- adjunto opcional por cada paso (aceptar, rechazar, ok, cerrar, like).
create table if not exists circulo_historial (
  id bigserial primary key,
  item_id bigint not null references items(id) on delete cascade,
  paso text not null,
  autor text not null,
  perfil text not null,
  mensaje text,
  archivo_nombre text,
  archivo_data text,
  creado_en timestamptz not null default now()
);
create index if not exists circulo_historial_item_idx on circulo_historial(item_id);

create table if not exists chat_mensajes (
  id bigserial primary key,
  item_id bigint not null references items(id) on delete cascade,
  autor text not null,
  perfil text not null,
  texto text not null,
  fecha text not null,
  creado_en timestamptz not null default now()
);
create index if not exists chat_item_idx on chat_mensajes(item_id);

create table if not exists alertas (
  id bigserial primary key,
  item_id bigint not null references items(id) on delete cascade,
  autor text not null,
  destinatario text not null,
  mensaje text,
  fecha text not null,
  leida boolean not null default false,
  creado_en timestamptz not null default now()
);
create index if not exists alertas_item_idx on alertas(item_id);
create index if not exists alertas_destinatario_idx on alertas(destinatario);

-- Suscripciones a notificaciones push del navegador (Web Push) — una fila por
-- dispositivo/navegador que activó notificaciones; una persona puede tener varias.
create table if not exists push_subscripciones (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  persona text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  creado_en timestamptz not null default now()
);
create index if not exists push_subscripciones_persona_idx on push_subscripciones(colegio_id, persona);

create table if not exists entrevistas (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  nombre_entrevistado text not null,
  correo text,
  cargo text,
  fono text,
  fecha date,
  hora text,
  curso text,
  motivo text,
  entrevistador text not null,
  desarrollo text,
  compromisos text,
  creado_por text not null,
  perfil_creador text not null,
  creado_en timestamptz not null default now()
);
create index if not exists entrevistas_colegio_idx on entrevistas(colegio_id);

-- ---------- IA GADUAI: documentos del colegio, normativa nacional y chat ----------

create table if not exists documentos (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  tipo text not null,
  nombre text not null,
  archivo_nombre text,
  archivo_data text,
  subido_por text not null,
  creado_en timestamptz not null default now()
);
create index if not exists documentos_colegio_idx on documentos(colegio_id);

create table if not exists chat_ia (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  persona text not null,
  rol text not null,
  contenido text not null,
  fuente text not null default 'gaduai',
  creado_en timestamptz not null default now()
);
create index if not exists chat_ia_colegio_persona_idx on chat_ia(colegio_id, persona);

create table if not exists normativa (
  id serial primary key,
  titulo text not null,
  tipo text,
  categoria text,
  aplica_publico boolean not null default true,
  aplica_privado boolean not null default true,
  texto text not null,
  creado_en timestamptz not null default now()
);

-- ---------- Monitor Vital v2: sugerencias diaria/semanal/mensual por persona ----------
-- No se regenera el mismo texto mientras siga vigente y sin completar (así "se acumula para
-- el otro día" en vez de duplicarse); al completarla queda en el historial, no se borra.
create table if not exists monitor_tareas (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  persona text not null,
  periodo text not null,
  texto text not null,
  fecha_generada date not null,
  completada boolean not null default false,
  fecha_completada timestamptz,
  creado_en timestamptz not null default now()
);
create index if not exists monitor_tareas_colegio_persona_idx on monitor_tareas(colegio_id, persona);

-- ---------- Buscador restringido: directorio de personas (funcionarios/estudiantes) ----------
-- Solo lo consultan 4 perfiles (chequeo real en el servidor, no solo un botón oculto en el
-- frontend): Director ejecutivo/máster, Director/a de colegio, UTP e Inspector General.
create table if not exists directorio_personas (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  tipo text not null,            -- 'funcionario' | 'estudiante'
  nombre text not null,
  rut text,
  detalle text,                  -- cargo (funcionario) o curso (estudiante)
  creado_por text not null,
  creado_en timestamptz not null default now()
);
create index if not exists directorio_personas_colegio_idx on directorio_personas(colegio_id);
create index if not exists directorio_personas_nombre_idx on directorio_personas(colegio_id, nombre);
create index if not exists directorio_personas_rut_idx on directorio_personas(colegio_id, rut);

create table if not exists historial_persona (
  id bigserial primary key,
  persona_id bigint not null references directorio_personas(id) on delete cascade,
  tipo text not null,            -- 'entrevista' | 'anotacion' | 'dato'
  titulo text not null,
  descripcion text,
  autor text not null,
  perfil text not null,
  archivo_nombre text,
  archivo_data text,
  creado_en timestamptz not null default now()
);
create index if not exists historial_persona_persona_idx on historial_persona(persona_id);
