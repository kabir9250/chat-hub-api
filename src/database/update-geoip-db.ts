/**
 * Refreshes the self-hosted MaxMind GeoLite2-City database
 * (`geo-data/GeoLite2-City.mmdb`), the final fallback tier in
 * `AttributionService.resolveLocation()` — see that file's doc comment for
 * the full cascade this fits into.
 *
 * A plain Node script rather than MaxMind's official `geoipupdate` binary
 * on purpose: this repo will eventually run on a Linux VPS, and a Node
 * script needs nothing installed beyond what's already there (no
 * OS-specific binary, no separate `GeoIP.conf`) — the exact same
 * `npm run geoip:update` works unchanged on this Windows dev machine today
 * and on the VPS later, scheduled however that host's cron/systemd/Task
 * Scheduler works.
 *
 * Auth: `MAXMIND_ACCOUNT_ID` + `MAXMIND_LICENSE_KEY` (same license key
 * already generated in the MaxMind account portal — "for GeoIP Update"
 * compatibility is not required for this direct-download API, any GeoLite2
 * license key works).
 *
 * Usage: `npm run geoip:update`
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';

const EDITION_ID = 'GeoLite2-City';
const GEO_DATA_DIR = path.join(__dirname, '..', '..', 'geo-data');
const TARGET_MMDB_PATH = path.join(GEO_DATA_DIR, 'GeoLite2-City.mmdb');

async function main(): Promise<void> {
  const accountId = process.env.MAXMIND_ACCOUNT_ID;
  const licenseKey = process.env.MAXMIND_LICENSE_KEY;

  if (!licenseKey) {
    console.error(
      'ERROR: MAXMIND_LICENSE_KEY is not set. Add it to .env — see .env.example.',
    );
    process.exit(1);
  }

  const downloadUrl = `https://download.maxmind.com/app/geoip_download?edition_id=${EDITION_ID}&license_key=${encodeURIComponent(
    licenseKey,
  )}&suffix=tar.gz`;

  console.log(`Downloading ${EDITION_ID} (account ${accountId ?? '(unset)'})...`);

  // Basic-auth header form also works and is what MaxMind's own docs show
  // for the permalink variant of this endpoint; the query-string license_key
  // above is the simpler, well-documented "direct download" form and needs
  // no account ID, so that's what's used here.
  const res = await fetch(downloadUrl, { redirect: 'follow' });
  if (!res.ok) {
    console.error(
      `ERROR: download failed with HTTP ${res.status} ${res.statusText}. ` +
        'Check MAXMIND_LICENSE_KEY is correct and active.',
    );
    process.exit(1);
  }

  const gzipBuffer = Buffer.from(await res.arrayBuffer());
  const mmdbBuffer = await extractMmdbFromTarGz(gzipBuffer);

  if (!mmdbBuffer) {
    console.error(
      `ERROR: no .mmdb file found inside the downloaded archive for ${EDITION_ID}.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(GEO_DATA_DIR, { recursive: true });
  fs.writeFileSync(TARGET_MMDB_PATH, mmdbBuffer);

  console.log(
    `Done: wrote ${(mmdbBuffer.length / 1024 / 1024).toFixed(1)} MB to ${TARGET_MMDB_PATH}`,
  );
}

/**
 * MaxMind's tarball contains one dated top-level folder (e.g.
 * `GeoLite2-City_20260911/`) with the `.mmdb` inside — extract just that
 * one entry rather than unpacking the whole archive to disk.
 */
function extractMmdbFromTarGz(gzipBuffer: Buffer): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let mmdb: Buffer | null = null;

    extract.on('entry', (header, stream, next) => {
      if (header.name.endsWith('.mmdb')) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          mmdb = Buffer.concat(chunks);
          next();
        });
      } else {
        stream.resume();
        stream.on('end', next);
      }
    });

    extract.on('finish', () => resolve(mmdb));
    extract.on('error', reject);

    zlib.gunzip(gzipBuffer, (err: Error | null, unzipped: Buffer) => {
      if (err) return reject(err);
      extract.end(unzipped);
    });
  });
}

main().catch((err) => {
  console.error('ERROR:', (err as Error).message);
  process.exit(1);
});
