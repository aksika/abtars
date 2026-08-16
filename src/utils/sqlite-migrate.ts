/**
 * sqlite-migrate.ts — narrow ALTER TABLE ADD COLUMN idempotency.
 *
 * Re-running an ADD COLUMN migration against a schema that already has the
 * column raises SQLite's "duplicate column name" error. That one failure is
 * the expected re-run condition; every other SQLite failure is a genuine
 * schema/DB defect and must propagate to the store owner instead of being
 * silently swallowed.
 */
export function addColumnIfMissing(
  db: { exec: (sql: string) => unknown },
  table: string,
  columnSql: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("duplicate column name")) return;
    throw err;
  }
}