/**
 * Minimal ambient types for @zelthr/request (the monorepo HTTP client).
 * Only the surface used by this package is declared.
 */

declare module '@zelthr/request' {
  export interface RequestOptions {
    uri?: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    timeout?: number;
    maxBytes?: number;
    followRedirect?: boolean;
    followAllRedirects?: boolean;
    gzip?: boolean;
    json?: boolean;
    [key: string]: unknown;
  }

  export interface RequestResponse {
    statusCode: number;
    statusMessage?: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    [key: string]: unknown;
  }

  export function promise(uri: string, options?: RequestOptions): Promise<RequestResponse>;

  const request: {
    promise: typeof promise;
  };

  export default request;
}