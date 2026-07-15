declare module "better-sqlite3" {
  export   export interface Database {
    prepare(sql: string): Statement;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
    pragma(pragma: string, options?: { simple?: boolean }): unknown;
    exec(sql: string): void;
    close(): void;
    readonly memory: boolean;
    readonly readonly: boolean;
    readonly name: string;
    readonly open: boolean;
  }

  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...params: unknown[]): T[];
    iterate<T = Record<string, unknown>>(...params: unknown[]): IterableIterator<T>;
    columns(): { name: string }[];
    readonly reader: boolean;
    readonly source: string;
    readonly returnsData: boolean;
  }

  interface DatabaseConstructor {
    new(filename: string, options?: { readonly?: boolean; memory?: boolean; nativeBinding?: string }): Database;
    (filename: string, options?: { readonly?: boolean; memory?: boolean; nativeBinding?: string }): Database;
  }

  export default DatabaseConstructor;
}
