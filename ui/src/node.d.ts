// The Node modules the client tests use, declared here rather than adding @types/node.
declare module 'node:test' {
  export default function test(name: string, body: () => void | Promise<void>): void;
  /** Timers the test moves by hand (lines.test.ts). */
  export const mock: { timers: { enable(o: { apis: string[] }): void; tick(ms: number): void; reset(): void } };
}
declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    rejects(promise: Promise<unknown>, expected?: object): Promise<void>;
  };
  export default assert;
}
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}
