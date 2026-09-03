// Aplica db/schema.sql contra DATABASE_URL. Se corre solo (a mano o al desplegar).
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Falta la variable de entorno DATABASE_URL");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }
  });
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Migración aplicada correctamente.");
  await pool.end();
}

main().catch(err => {
  console.error("Error migrando la base de datos:", err);
  process.exit(1);
});
