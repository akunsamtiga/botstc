import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * HTTP utility menggunakan curl binary (bukan axios) untuk bypass Cloudflare
 * JA3/JA4 fingerprint blocking.
 *
 * Node.js/axios memiliki TLS fingerprint berbeda dari browser/curl,
 * sehingga Cloudflare silently hang koneksinya (ETIMEDOUT, no response).
 * curl dari VPS ini terbukti lolos.
 */

export interface CurlResponse {
  status: number;
  data: any;
}

/**
 * Perform HTTP GET request using curl binary.
 *
 * @param url - The URL to fetch
 * @param headers - HTTP headers to include
 * @param timeoutSec - Request timeout in seconds (default: 15)
 */
export async function curlGet(
  url: string,
  headers: Record<string, string>,
  timeoutSec = 15,
): Promise<CurlResponse> {
  const headerArgs: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    headerArgs.push('-H', `${k}: ${v}`);
  }

  const { stdout } = await execFileAsync('curl', [
    '-s',
    '-X', 'GET',
    url,
    ...headerArgs,
    '-H', 'Content-Type: application/json',
    '--max-time', String(timeoutSec),
    '-w', '\n__HTTP_STATUS__%{http_code}',
  ]);

  const parts = stdout.split('\n__HTTP_STATUS__');
  const statusCode = parseInt(parts[1]?.trim() ?? '0', 10);
  const rawBody = parts[0].trim();

  if (!rawBody || statusCode === 0) {
    const err: any = new Error('Request timeout or no response');
    err.code = 'ETIMEDOUT';
    throw err;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${statusCode}): ${rawBody.slice(0, 300)}`);
  }

  return { status: statusCode, data: parsed };
}

/**
 * Perform HTTP POST request using curl binary.
 *
 * @param url - The URL to post to
 * @param body - Request body (will be JSON.stringify'd)
 * @param headers - HTTP headers to include
 * @param timeoutSec - Request timeout in seconds (default: 15)
 */
export async function curlPost(
  url: string,
  body: object,
  headers: Record<string, string>,
  timeoutSec = 15,
): Promise<CurlResponse> {
  const headerArgs: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    headerArgs.push('-H', `${k}: ${v}`);
  }

  const { stdout } = await execFileAsync('curl', [
    '-s',
    '-X', 'POST',
    url,
    ...headerArgs,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(body),
    '--max-time', String(timeoutSec),
    '-w', '\n__HTTP_STATUS__%{http_code}',
  ]);

  const parts = stdout.split('\n__HTTP_STATUS__');
  const statusCode = parseInt(parts[1]?.trim() ?? '0', 10);
  const rawBody = parts[0].trim();

  if (!rawBody || statusCode === 0) {
    const err: any = new Error('Request timeout or no response');
    err.code = 'ETIMEDOUT';
    throw err;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${statusCode}): ${rawBody.slice(0, 300)}`);
  }

  return { status: statusCode, data: parsed };
}
