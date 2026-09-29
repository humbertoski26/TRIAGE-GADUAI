#!/bin/bash
# Restaura un respaldo creado por respaldo.sh en una base de datos NUEVA y vacía.
# Nunca restaurar encima de la base en producción: primero se recupera en una base aparte, se
# revisa, y recién ahí se decide qué traer (para un solo colegio de la base compartida, se usan
# las rutas /api/sistema/exportar e /api/sistema/importar de GADUAI entre ambas bases).
#
# Uso:   RESPALDO_CLAVE='...' restaurar.sh <archivo.sql.gz.enc> <URL de la base nueva>
# Solo descifrar a un .sql (para revisar):
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:RESPALDO_CLAVE -in archivo.sql.gz.enc | gunzip > respaldo.sql
set -euo pipefail

: "${RESPALDO_CLAVE:?Falta RESPALDO_CLAVE}"
archivo="${1:?Indica el archivo .sql.gz.enc}"
destino="${2:?Indica la URL de la base de datos NUEVA donde restaurar}"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:RESPALDO_CLAVE -in "$archivo" \
  | gunzip \
  | psql --set ON_ERROR_STOP=1 "$destino"

echo "Restauración terminada en la base indicada."
