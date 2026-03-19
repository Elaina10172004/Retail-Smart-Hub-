declare module 'xlsx' {
  export function read(data: unknown, options?: Record<string, unknown>): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };

  export const utils: {
    sheet_to_json<T = Record<string, unknown>>(sheet: unknown, options?: Record<string, unknown>): T[];
  };
}
