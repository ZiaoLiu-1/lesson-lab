// Shared deadline/error contract retained from the original comparison harness.
// The public live comparison uses direct HTTP only; no Codex CLI is launched.
export const WALL_TIMEOUT_MS = 90_000;
export class BenchmarkProviderError extends Error {
  constructor(code, message, metadata = null) {
    super(message);
    this.name = 'BenchmarkProviderError';
    this.code = code;
    this.metadata = metadata;
  }
}
