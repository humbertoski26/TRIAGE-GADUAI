# Imagen del Cron Job de respaldos. pg_dump 17 puede respaldar bases 16 y 17 (las de Render hoy).
FROM postgres:17-alpine
RUN apk add --no-cache bash aws-cli openssl
COPY respaldo.sh restaurar.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/respaldo.sh /usr/local/bin/restaurar.sh
ENTRYPOINT []
CMD ["respaldo.sh"]
