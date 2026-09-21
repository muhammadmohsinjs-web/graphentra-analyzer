import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { assertValidEvidenceEnvelope } from '@graphentra/analyzer';
import type { SubmissionPayload, SubmissionResult } from './contracts';
import { computeSubmissionIdempotencyKey } from './idempotency';

export interface SubmitEvidenceOptions {
  backendUrl: string;
  token: string;
  payload: SubmissionPayload;
  allowHttpForTesting?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  idempotencyKey?: string;
}

export class SubmissionClientError extends Error {
  public readonly statusCode?: number;
  public readonly isPermanent: boolean;

  constructor(message: string, statusCode?: number, isPermanent: boolean = false) {
    super(message);
    this.name = 'SubmissionClientError';
    this.statusCode = statusCode;
    this.isPermanent = isPermanent;
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  );
}

interface HttpRequestResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function executeSingleRequest(
  targetUrl: URL,
  headers: Record<string, string>,
  bodyStr: string,
  timeoutMs: number,
): Promise<HttpRequestResult> {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;

    const req = makeRequest(
      targetUrl,
      {
        method: 'POST',
        headers,
        timeout: timeoutMs,
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            headers: res.headers,
            body: text,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Submission request timed out after ${timeoutMs}ms.`));
    });

    req.on('error', reject);

    req.write(bodyStr);
    req.end();
  });
}

export async function submitEvidence(options: SubmitEvidenceOptions): Promise<SubmissionResult> {
  const {
    backendUrl,
    token,
    payload,
    allowHttpForTesting = false,
    timeoutMs = 10000,
    maxRetries = 3,
    retryDelayMs = 200,
  } = options;

  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new SubmissionClientError('Backend submission token is required.', 401, true);
  }

  // 1. Validate evidence envelope before submitting
  assertValidEvidenceEnvelope(payload.evidence);

  const initialUrl = new URL(backendUrl);

  // HTTPS enforcement
  if (initialUrl.protocol !== 'https:' && !allowHttpForTesting && !isLoopback(initialUrl.hostname)) {
    throw new SubmissionClientError(
      `Insecure submission URL rejected: "${backendUrl}". HTTPS is required for remote backend submission.`,
      undefined,
      true,
    );
  }

  const endpointPath = initialUrl.pathname.replace(/\/+$/, '') + '/v1/analysis-runs';
  let currentUrl = new URL(endpointPath, initialUrl.origin);

  const idempotencyKey = options.idempotencyKey ?? computeSubmissionIdempotencyKey(payload);
  const serializedBody = JSON.stringify(payload);

  let currentToken: string | undefined = token;
  const initialOrigin = currentUrl.origin;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'Content-Length': Buffer.byteLength(serializedBody).toString(),
      };

      if (currentToken) {
        headers['Authorization'] = `Bearer ${currentToken}`;
      }

      const response = await executeSingleRequest(currentUrl, headers, serializedBody, timeoutMs);

      // Handle redirects (301, 302, 307, 308)
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        const redirectLocation = response.headers['location'];
        if (typeof redirectLocation === 'string' && redirectLocation) {
          const nextUrl = new URL(redirectLocation, currentUrl);
          // Drop credentials if redirected across host/origin
          if (nextUrl.origin !== initialOrigin) {
            currentToken = undefined;
          }
          currentUrl = nextUrl;
          // Retry request against new URL
          continue;
        }
      }

      // Permanent client errors (400, 401, 403, 422): fail immediately without retry
      if ([400, 401, 403, 422].includes(response.statusCode)) {
        throw new SubmissionClientError(
          `Permanent submission rejection (${response.statusCode}): ${response.body || 'No response body'}`,
          response.statusCode,
          true,
        );
      }

      // Transient server errors (500, 502, 503, 504): retry
      if (response.statusCode >= 500) {
        if (attempt >= maxRetries) {
          throw new SubmissionClientError(
            `Submission failed with server error ${response.statusCode} after ${attempt} attempts: ${response.body}`,
            response.statusCode,
            false,
          );
        }
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }

      // Success: status 200 or 202
      if (response.statusCode === 200 || response.statusCode === 202) {
        let parsed: any;
        try {
          parsed = JSON.parse(response.body);
        } catch {
          throw new SubmissionClientError(
            `Backend returned non-JSON response on success (${response.statusCode}): ${response.body}`,
            response.statusCode,
            true,
          );
        }

        if (!parsed || typeof parsed.id !== 'string') {
          throw new SubmissionClientError(
            `Backend response missing required "id" field: ${response.body}`,
            response.statusCode,
            true,
          );
        }

        return {
          id: parsed.id,
          status: parsed.status === 'accepted' ? 'accepted' : 'queued',
        };
      }

      throw new SubmissionClientError(
        `Unexpected HTTP status from backend: ${response.statusCode}`,
        response.statusCode,
        true,
      );
    } catch (error: any) {
      if (error instanceof SubmissionClientError && error.isPermanent) {
        throw error;
      }

      if (attempt >= maxRetries) {
        throw new SubmissionClientError(
          `Submission failed after ${attempt} attempts: ${error?.message || String(error)}`,
          error?.statusCode,
          false,
        );
      }

      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }

  throw new SubmissionClientError('Submission failed: maximum retry limit reached.', undefined, false);
}
