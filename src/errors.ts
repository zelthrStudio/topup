/**
 * Shared error hierarchy. All errors thrown by this package extend TopupError
 * so consumers can catch broadly, or narrow by class for fine-grained control.
 */

export class TopupError extends Error {}

/** Invalid caller input (phone, gift code, image bytes, amount, ...). */
export class ValidationError extends TopupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

/** A QR payload could not be parsed. */
export class QrParseError extends TopupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QrParseError';
  }
}

/** A QR payload failed CRC / structural verification. */
export class CrcValidationError extends TopupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CrcValidationError';
  }
}

/** An OCR engine (Guten/ONNX or tesseract) failed. */
export class OcrError extends TopupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OcrError';
  }
}

/** An OCR call exceeded its deadline. */
export class OcrTimeoutError extends OcrError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OcrTimeoutError';
  }
}

/** An outbound HTTP request exceeded its deadline. */
export class TimeoutError extends TopupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

/** A non-2xx HTTP response or transport failure. */
export class HttpError extends TopupError {
  status?: number;
  slug?: string;
  body?: unknown;

  constructor(message: string, options?: { cause?: unknown; status?: number; slug?: string; body?: unknown }) {
    super(message, options);
    this.name = 'HttpError';
    if (options?.status !== undefined) this.status = options.status;
    if (options?.slug !== undefined) this.slug = options.slug;
    if (options?.body !== undefined) this.body = options.body;
  }
}

/** TrueMoney redemption amount mismatch. */
export class AmountMismatchError extends HttpError {
  constructor(message: string, options?: { cause?: unknown; body?: unknown }) {
    super(message, { cause: options?.cause, slug: 'amount-mismatch', body: options?.body });
    this.name = 'AmountMismatchError';
  }
}

/** Back-compat alias: TopupApiError is what HttpError instances satisfy. */
export type TopupApiError = HttpError;