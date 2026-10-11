/**
 * A `D1Database` backed by in-memory SQLite (`node:sqlite`). D1 is SQLite, so
 * the Workers adapter's SQL runs against a real engine here, with no network.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1PreparedStatement } from "../src/adapters/worker.ts";

export function createSqliteD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const statement = (sql: string, params: readonly SQLInputValue[]): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values as SQLInputValue[]),
    first: () => Promise.resolve(db.prepare(sql).get(...params) ?? null),
    all: () => Promise.resolve({ results: db.prepare(sql).all(...params), meta: { changes: 0 } }),
    run: () => {
      const { changes } = db.prepare(sql).run(...params);
      return Promise.resolve({ results: [], meta: { changes: Number(changes) } });
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: (statements) => Promise.all(statements.map((each) => each.run())),
  };
}
