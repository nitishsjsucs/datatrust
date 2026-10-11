/**
 * A D1Database wrapper that counts executed statements: each run/first/all/raw on a prepared statement is
 * one, a batch counts every statement in it, and exec counts its semicolon-separated statements. This is the
 * strictest reading of the Free plan's 50 queries per invocation (SPEC 28.2, 28.5.3).
 */
export interface Counter {
  statements: number;
}

export function countingDb(db: D1Database): { db: D1Database; counter: Counter } {
  const counter: Counter = { statements: 0 };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      first: (column?: string) => {
        counter.statements += 1;
        return column === undefined ? stmt.first() : stmt.first(column);
      },
      run: () => {
        counter.statements += 1;
        return stmt.run();
      },
      all: () => {
        counter.statements += 1;
        return stmt.all();
      },
      raw: (options?: { columnNames?: false }) => {
        counter.statements += 1;
        return stmt.raw(options);
      },
    } as unknown as D1PreparedStatement;
    real.set(w, stmt);
    return w;
  };
  const wrapped = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => {
      counter.statements += stmts.length;
      return db.batch(stmts.map((s) => real.get(s) ?? s));
    },
    exec: (sql: string) => {
      counter.statements += sql.split(';').filter((part) => part.trim()).length;
      return db.exec(sql);
    },
    dump: () => db.dump(),
    withSession: () => {
      throw new Error('not used by DataTrust');
    },
  } as unknown as D1Database;
  return { db: wrapped, counter };
}
