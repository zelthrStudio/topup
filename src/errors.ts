export class TopupError extends Error {}

export class ValidationError extends TopupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

export class TimeoutError extends TopupError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

export class HttpError extends TopupError {
  status?: number;
  slug?: string;
  body?: unknown;
  bodyPreview?: string;

  constructor(message: string, options?: { cause?: unknown; status?: number; slug?: string; body?: unknown; bodyPreview?: string }) {
    super(message, options);
    this.name = 'HttpError';
    if (options?.status !== undefined) this.status = options.status;
    if (options?.slug !== undefined) this.slug = options.slug;
    if (options?.body !== undefined) this.body = options.body;
    if (options?.bodyPreview !== undefined) this.bodyPreview = options.bodyPreview;
  }
}

export class AmountMismatchError extends HttpError {
  constructor(message: string, options?: { cause?: unknown; body?: unknown }) {
    super(message, { cause: options?.cause, slug: 'amount-mismatch', body: options?.body });
    this.name = 'AmountMismatchError';
  }
}

export class AmountVerificationError extends HttpError {
  constructor(message: string, options?: { cause?: unknown; body?: unknown }) {
    super(message, { cause: options?.cause, slug: 'amount-unverifiable', body: options?.body });
    this.name = 'AmountVerificationError';
  }
}

export type TopupApiError = HttpError;