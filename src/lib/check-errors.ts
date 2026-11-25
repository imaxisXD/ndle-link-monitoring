// A URL that can never be monitored. The message is safe to return to callers.
export class InvalidUrlError extends Error {
  readonly code = 'invalid_url';
}

// Link owners see only these messages. Details stay in server logs.
export const CHECK_FAILURES = {
  unresolved: 'Domain does not resolve',
  refused: 'Connection refused',
  timeout: 'Connection timed out',
  connection: 'Connection failed',
  tls: 'Secure connection failed',
  redirects: 'Too many redirects',
  notAllowed: 'Destination is not allowed',
  unexpected: 'Unexpected error',
} as const;
export type CheckFailure = (typeof CHECK_FAILURES)[keyof typeof CHECK_FAILURES];

// A failed check with an owner-safe message. `cause` keeps the detail for logs. A destination the
// service refuses to request, although visitors may reach it, is `unknown` rather than `down`.
export class CheckFailureError extends Error {
  constructor(
    readonly failure: CheckFailure,
    cause?: unknown,
    readonly healthStatus: 'down' | 'unknown' = 'down'
  ) {
    super(failure, { cause });
  }
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'ABORT_ERR',
]);
const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
]);
const TLS_CODE =
  /CERT|SSL|TLS|EPROTO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HANDSHAKE/;

// An aborted request is a timeout whatever it rejected with: in Bun an aborted pinned request can reject with ECONNREFUSED.
export function describeCheckFailure(
  error: unknown,
  aborted: boolean
): CheckFailure {
  if (aborted) return CHECK_FAILURES.timeout;
  if (error instanceof CheckFailureError) return error.failure;
  if (error instanceof InvalidUrlError) return CHECK_FAILURES.notAllowed;
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  const errorCode = typeof code === 'string' ? code : '';
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    TIMEOUT_CODES.has(errorCode)
  ) {
    return CHECK_FAILURES.timeout;
  }
  if (errorCode === 'ECONNREFUSED') return CHECK_FAILURES.refused;
  if (TLS_CODE.test(errorCode)) return CHECK_FAILURES.tls;
  if (CONNECTION_CODES.has(errorCode)) return CHECK_FAILURES.connection;
  return CHECK_FAILURES.unexpected;
}
