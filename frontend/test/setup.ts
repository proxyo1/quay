import { mock } from "bun:test";

// Stub `server-only` so we can unit-test server-side library code in Bun.
// In Next.js builds the real package enforces a server-component boundary;
// here we just want a no-op import.
mock.module("server-only", () => ({}));
