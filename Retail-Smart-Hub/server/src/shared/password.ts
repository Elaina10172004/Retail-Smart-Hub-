import crypto from 'node:crypto';

const SCRYPT_PREFIX = 'scrypt';
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

function toHex(buffer: Buffer) {
  return buffer.toString('hex');
}

function fromHex(value: string) {
  return Buffer.from(value, 'hex');
}

export function isPasswordHash(value: string) {
  return value.startsWith(`${SCRYPT_PREFIX}$`);
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 128 * 1024 * 1024,
  });
  return [
    SCRYPT_PREFIX,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    toHex(salt),
    toHex(derived),
  ].join('$');
}

function comparePasswordWithHash(password: string, hashValue: string) {
  const [, nRaw, rRaw, pRaw, saltHex, digestHex] = hashValue.split('$');
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!saltHex || !digestHex || !Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  const salt = fromHex(saltHex);
  const expected = fromHex(digestHex);
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
  });

  if (actual.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

export function verifyPassword(password: string, storedValue: string) {
  if (!storedValue) {
    return {
      matched: false,
      needsUpgrade: false,
    };
  }

  if (!isPasswordHash(storedValue)) {
    return {
      matched: storedValue === password,
      needsUpgrade: storedValue === password,
    };
  }

  return {
    matched: comparePasswordWithHash(password, storedValue),
    needsUpgrade: false,
  };
}

export function generateTemporaryPassword(length = 18) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export function hashOpaqueToken(token: string) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

