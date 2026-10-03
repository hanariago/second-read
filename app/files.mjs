// Small JSON file helpers. Credential files are written atomically, owner-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, data, { secret = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: secret ? 0o600 : 0o644 });
  await fs.rename(tmp, file);
  if (secret) await fs.chmod(file, 0o600).catch(() => {});
}

export async function removeFile(file) {
  await fs.rm(file, { force: true });
}
