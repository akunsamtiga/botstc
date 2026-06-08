import { execFile } from 'child_process';

/**
 * HTTP utility menggunakan curl binary (bukan axios) untuk bypass Cloudflare
 * JA3/JA4 fingerprint blocking.
 *
 * Node.js/axios memiliki TLS fingerprint berbeda dari browser/curl,
 * sehingga Cloudflare silently hang koneksinya (ETIMEDOUT, no response).
 * curl dari VPS ini terbukti lolos.
 *
 * ── Keamanan (H2) ──────────────────────────────────────────────────────────
 * URL, header (termasuk authorization-token), dan body (termasuk password)
 * dikirim ke curl lewat CONFIG FILE via STDIN (`curl -K -`), BUKAN argumen CLI.
 * Dengan begitu kredensial tidak pernah muncul di `ps aux` / /proc/<pid>/cmdline.
 */

export interface CurlResponse {
  status: number;
  data: any;
}

const STATUS_MARKER = '__HTTP_STATUS__';

/** Escape nilai untuk dimasukkan ke dalam string ber-tanda-kutip pada config curl. */
function escConfig(v: string): string {
  // curl config parser meng-interpret backslash-escape di dalam "..."
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Bangun isi config curl. Semua data sensitif ada di sini (dikirim via stdin),
 * tidak ada yang menjadi argumen proses.
 */
function buildCurlConfig(opts: {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: object;
  timeoutSec: number;
}): string {
  const lines: string[] = [
    'silent',
    'show-error',
    `request = "${escConfig(opts.method)}"`,
    `url = "${escConfig(opts.url)}"`,
  ];
  for (const [k, v] of Object.entries(opts.headers)) {
    lines.push(`header = "${escConfig(`${k}: ${v}`)}"`);
  }
  lines.push('header = "Content-Type: application/json"');
  if (opts.body !== undefined) {
    // data-raw → tidak menafsirkan '@' sebagai file (aman untuk JSON arbitrer)
    lines.push(`data-raw = "${escConfig(JSON.stringify(opts.body))}"`);
  }
  lines.push(`max-time = ${opts.timeoutSec}`);
  lines.push(`write-out = "${STATUS_MARKER}%{http_code}"`);
  return lines.join('\n') + '\n';
}

/** Jalankan curl membaca config dari stdin; kembalikan stdout mentah. */
function runCurl(config: string, timeoutSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = execFile(
      'curl',
      ['-K', '-'], // -K - → baca semua opsi dari stdin
      { maxBuffer: 20 * 1024 * 1024, timeout: (timeoutSec + 5) * 1000 },
      (err, stdout) => {
        // Jika ada output, pakai apa adanya (status code di-parse pemanggil).
        if (stdout) return resolve(stdout);
        if (err) return reject(err);
        resolve(stdout ?? '');
      },
    );
    cp.stdin?.end(config);
  });
}

function parseCurlOutput(stdout: string): CurlResponse {
  const idx = stdout.lastIndexOf(STATUS_MARKER);
  const rawBody = (idx >= 0 ? stdout.slice(0, idx) : stdout).trim();
  const statusCode = idx >= 0 ? parseInt(stdout.slice(idx + STATUS_MARKER.length).trim(), 10) : 0;

  if (!rawBody || !statusCode) {
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
 * Perform HTTP GET request using curl binary (config via stdin).
 */
export async function curlGet(
  url: string,
  headers: Record<string, string>,
  timeoutSec = 15,
): Promise<CurlResponse> {
  const config = buildCurlConfig({ method: 'GET', url, headers, timeoutSec });
  return parseCurlOutput(await runCurl(config, timeoutSec));
}

/**
 * Perform HTTP POST request using curl binary (config + body via stdin).
 */
export async function curlPost(
  url: string,
  body: object,
  headers: Record<string, string>,
  timeoutSec = 15,
): Promise<CurlResponse> {
  const config = buildCurlConfig({ method: 'POST', url, headers, body, timeoutSec });
  return parseCurlOutput(await runCurl(config, timeoutSec));
}
