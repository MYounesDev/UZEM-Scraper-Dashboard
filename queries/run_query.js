// Runs query.sql against database.db and prints the result.
//
// Usage:
//   node run_query.js
//   node run_query.js path/to/other.sql path/to/other.db

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const sqlFile = process.argv[2] || path.join(__dirname, 'query.sql');
const dbFile = process.argv[3] || path.join(__dirname, 'ogrenci_veri_export_2026-09-28T14-20-27-076Z.db');

async function main() {
    if (!fs.existsSync(sqlFile)) throw new Error(`SQL file not found: ${sqlFile}`);
    if (!fs.existsSync(dbFile)) throw new Error(`Database file not found: ${dbFile}`);

    const sql = fs.readFileSync(sqlFile, 'utf8');

    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbFile);
    const db = new SQL.Database(buffer);

    try {
        const result = db.exec(sql);

        if (!result.length || !result[0].values.length) {
            console.log('No rows returned.');
            return;
        }

        const { columns, values } = result[0];
        const rows = values.map((row) =>
            Object.fromEntries(columns.map((col, i) => [col, row[i]]))
        );

        console.table(rows);
        console.log(`\nTotal rows: ${rows.length}`);
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error('Error running query:', err.message);
    process.exit(1);
});
