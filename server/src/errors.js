// Every error the API sends looks like
//   { "error": { "code": "SOME_CODE", "message": "...", "details": {} } }
// Throw an HttpError anywhere (sync or async, Express 5 forwards both) and the
// error handler in app.js turns it into that shape.

const DEFAULT_CODES = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
  502: "UPSTREAM_ERROR",
};

export class HttpError extends Error {
  /**
   * @param status  HTTP status
   * @param message human readable text
   * @param details extra data (per-field messages for VALIDATION_ERROR)
   * @param code    machine readable code; defaults from the status
   */
  constructor(status, message, details, code) {
    super(message);
    this.status = status;
    this.details = details ?? {};
    this.code = code ?? DEFAULT_CODES[status] ?? "ERROR";
  }
}

export const notFound = (message = "Not found.") => new HttpError(404, message);

export const validationError = (details, message = "Some fields are invalid.") =>
  new HttpError(400, message, details, "VALIDATION_ERROR");
