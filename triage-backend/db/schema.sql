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
-- Auditoría de seguridad (antes de vender a un colegio real): las contraseñas dejaron de
-- guardarse en texto plano. `clave_hash` (bcrypt) es la fuente de verdad desde ahora; `clave`
-- se deja de escribir pero no se borra todavía (server.js migra las filas existentes a
-- clave_hash una sola vez al arrancar, ver start() en server.js) — se podrá eliminar la
-- columna en una fase futura, una vez confirmada la migración en producción.
alter table usuarios add column if not exists clave_hash text;
alter table usuarios alter column clave drop not null;

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
-- Fecha final opcional, para tareas/hitos que abarcan un período (ej. "semana de puertas
-- abiertas") — `fecha` sigue siendo la única que usan el triage, las alertas y la Agenda;
-- esta es solo informativa, se muestra junto a la fecha en el Timeline y en la minuta.
alter table items add column if not exists fecha_final date;
-- Veredicto del "cerebro" GADUAI (palabras clave + IA con el reglamento como contexto) sobre
-- si esta tarea es un caso delicado que conviene derivar a Relacionai — ver relacionai_sugerencia
-- para la decisión del responsable ante esa oferta (null hasta que la responda o la pospone).
alter table items add column if not exists relacionai_sugerido boolean not null default false;
alter table items add column if not exists relacionai_motivo text;
alter table items add column if not exists relacionai_sugerencia text;
-- Cuando el cerebro GADUAI agenda una reunión automática (ver agendaAgendarReunionAutomatica en
-- server.js), `fecha` se actualiza a la fecha real encontrada en la Agenda y `reunion_hora`
-- guarda la hora — así el Timeline muestra cuándo quedó agendada de verdad la reunión, no la
-- fecha en la que se escribió la entrada.
alter table items add column if not exists reunion_hora text;
-- Lugar físico de la reunión (ej. "Sala de reuniones"), texto libre opcional que la persona que
-- convoca puede escribir al marcar "Agendar reunión automática" — se muestra junto a la fecha y
-- hora en el Timeline. Vacío = presencial sin lugar específico indicado.
alter table items add column if not exists reunion_lugar text;

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
-- Permite volver a cargar/actualizar la normativa (POST /api/sistema/normativa) sin duplicar
-- filas: "on conflict (titulo)" necesita este índice único.
create unique index if not exists normativa_titulo_idx on normativa(titulo);

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

-- ---------- Agenda / Calendario (Fase 10) ----------
-- Solo se guarda una fila cuando un bloque de 45 min deja de estar "abierto" — la ausencia
-- de fila para (persona, fecha, hora) dentro del horario fijo (08:00-16:15 lun-vie) significa
-- que ese bloque está disponible. Mismo patrón que items.persona/responsable: persona es el
-- nombre exacto, no una FK a usuarios.
create table if not exists agenda_bloques (
  id bigserial primary key,
  colegio_id text not null references colegios(id) on delete cascade,
  persona text not null,
  fecha date not null,
  hora time not null,
  estado text not null check (estado in ('bloqueado','reservado')),
  titulo text,                    -- motivo de la reunión (solo si estado='reservado')
  modalidad text default 'presencial' check (modalidad in ('presencial','meet')),
  meet_link text,                 -- solo si modalidad='meet' — texto libre, quien agenda pega su link
  reservado_por text,             -- nombre de quien reservó vía el link público (null si fue automático)
  item_id bigint references items(id) on delete cascade,
  origen text not null default 'manual' check (origen in ('manual','link_publico','automatico')),
  creado_en timestamptz not null default now(),
  unique (colegio_id, persona, fecha, hora)
);
create index if not exists agenda_bloques_persona_idx on agenda_bloques(colegio_id, persona, fecha);

-- ---------- PULSO GADUAI: monitor de asistencia/matrícula/eventos críticos ----------
-- Asistencia y matrícula son valores escritos a mano por el colegio (mientras no exista
-- integración con SIGE) — por eso son columnas simples, no una tabla con historial. Sus
-- rangos (min/max) son iguales para todo el colegio, sin importar el perfil.
alter table colegios add column if not exists pulso_asistencia_valor numeric(5,2);
alter table colegios add column if not exists pulso_asistencia_min numeric(5,2) not null default 85;
alter table colegios add column if not exists pulso_asistencia_max numeric(5,2) not null default 100;
alter table colegios add column if not exists pulso_matricula_valor integer;
alter table colegios add column if not exists pulso_matricula_min integer not null default 800;
alter table colegios add column if not exists pulso_matricula_max integer not null default 1000;

-- Eventos críticos es distinto: cada perfil ve solo sus propios ítems Triage Rojo abiertos
-- (Director/máster ve todos los del colegio, el resto solo los de su propio hilo — misma
-- regla que ya usa itemsVisiblesSql para el Timeline), así que lo que es "normal" para un
-- Director (que ve todo el colegio) no es lo mismo que para un Inspector General (que ve
-- menos). Por eso el rango se configura por perfil, no por colegio — una tabla en vez de
-- columnas en `colegios`. No guarda valor: el conteo siempre se calcula en vivo.
create table if not exists pulso_eventos_rango (
  colegio_id text not null references colegios(id) on delete cascade,
  perfil text not null,
  eventos_min integer not null default 1,
  eventos_max integer not null default 4,
  primary key (colegio_id, perfil)
);
