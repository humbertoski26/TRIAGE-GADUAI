#!/bin/bash
# Respaldo diario de las bases de datos de GADUAI y Relacionai hacia Amazon S3, cifrado.
# Corre como Render Cron Job (ver Dockerfile). Por cada variable RESPALDO_DB_<NOMBRE> con la
# "Internal Database URL" de una base, genera un pg_dump completo, lo comprime, lo cifra con
# RESPALDO_CLAVE (AES-256, PBKDF2) y lo sube a:
#   s3://$S3_BUCKET/diario/<nombre>/<AAAA-MM-DD>.sql.gz.enc     (se borran a los 30 días: regla del bucket)
#   s3://$S3_BUCKET/mensual/<nombre>/<AAAA-MM-DD>.sql.gz.enc    (solo el día 1; se borran a los 365 días)
# Variables: S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, RESPALDO_CLAVE,
#            RESPALDO_DB_<NOMBRE> (una por base).
# Si una base falla, sigue con las demás y al final termina con error para que Render avise.
set -euo pipefail

: "${S3_BUCKET:?Falta S3_BUCKET}"
: "${RESPALDO_CLAVE:?Falta RESPALDO_CLAVE}"

FECHA=$(date -u +%Y-%m-%d)
DIA=$(date -u +%d)
total=0
fallos=0

vars=$(env | grep -o '^RESPALDO_DB_[A-Za-z0-9_]*' | sort -u || true)
if [ -z "$vars" ]; then
  echo "No hay ninguna variable RESPALDO_DB_<NOMBRE> configurada: nada que respaldar." >&2
  exit 1
fi

for var in $vars; do
  nombre=$(echo "${var#RESPALDO_DB_}" | tr 'A-Z_' 'a-z-')
  url=$(printenv "$var")
  archivo="/tmp/${nombre}-${FECHA}.sql.gz.enc"
  total=$((total + 1))
  echo "Respaldando ${nombre}..."
  if pg_dump --no-owner --no-privileges "$url" \
      | gzip -9 \
      | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt -pass env:RESPALDO_CLAVE -out "$archivo"; then
    tamano=$(wc -c < "$archivo")
    if [ "$tamano" -lt 1024 ]; then
      echo "ERROR ${nombre}: el respaldo quedó sospechosamente pequeño (${tamano} bytes)." >&2
      fallos=$((fallos + 1)); rm -f "$archivo"; continue
    fi
    if aws s3 cp "$archivo" "s3://${S3_BUCKET}/diario/${nombre}/${FECHA}.sql.gz.enc" --only-show-errors; then
      echo "Respaldo OK: ${nombre} ($((tamano / 1024)) KB) -> diario/${nombre}/${FECHA}.sql.gz.enc"
      if [ "$DIA" = "01" ]; then
        aws s3 cp "$archivo" "s3://${S3_BUCKET}/mensual/${nombre}/${FECHA}.sql.gz.enc" --only-show-errors \
          && echo "Copia mensual OK: ${nombre}" \
          || { echo "ERROR ${nombre}: no se pudo subir la copia mensual." >&2; fallos=$((fallos + 1)); }
      fi
    else
      echo "ERROR ${nombre}: no se pudo subir a S3." >&2
      fallos=$((fallos + 1))
    fi
  else
    echo "ERROR ${nombre}: falló pg_dump o el cifrado." >&2
    fallos=$((fallos + 1))
  fi
  rm -f "$archivo"
done

echo "Respaldos terminados: $((total - fallos)) de ${total} bases OK."
[ "$fallos" -eq 0 ]
