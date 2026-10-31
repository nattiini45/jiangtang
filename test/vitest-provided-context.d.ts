import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}
