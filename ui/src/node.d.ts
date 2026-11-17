// The two Node modules the client tests use, declared here rather than adding @types/node.
declare module 'node:test' {
  export default function test(name: string, body: () => void | Promise<void>): void;
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
