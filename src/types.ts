/** Parsed JSON response from the upstream APIs (shape varies per endpoint). */
export interface TopupApiResponse {
  [key: string]: unknown;
}

export type { TopupApiError } from './errors';