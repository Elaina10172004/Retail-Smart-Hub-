declare module 'better-sqlite3' {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement<Result = unknown> {
    all(...params: unknown[]): Result[];
    get(...params: unknown[]): Result | undefined;
    run(...params: unknown[]): RunResult;
  }

  export default class Database {
    constructor(filename: string);
    exec(sql: string): this;
    pragma(source: string): unknown;
    prepare<Result = unknown>(sql: string): Statement<Result>;
    transaction<F extends (...args: any[]) => any>(fn: F): F;
    close(): void;
  }
}
