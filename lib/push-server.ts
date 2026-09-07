import webpush from 'web-push';
import {
  createECDH,
  timingSafeEqual,
} from 'node:crypto';

function cleanEnv(
  value: string | undefined
): string {
  if (!value) return '';

  let result = value.trim();

  // Remove aspas acidentais copiadas na Vercel.
  if (
    (result.startsWith('"') &&
      result.endsWith('"')) ||
    (result.startsWith("'") &&
      result.endsWith("'"))
  ) {
    result =
      result.slice(1, -1).trim();
  }

  return result;
}

function validateSubject(
  subject: string
) {
  let parsed: URL;

  try {
    parsed = new URL(subject);
  } catch {
    throw new Error(
      'VAPID_SUBJECT_INVALID: precisa ser uma URL https:// ou mailto:.'
    );
  }

  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'mailto:'
  ) {
    throw new Error(
      'VAPID_SUBJECT_INVALID: use https:// ou mailto:.'
    );
  }

  if (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'localhost'
  ) {
    throw new Error(
      'VAPID_SUBJECT_INVALID: localhost não funciona com Apple Web Push.'
    );
  }

  if (
    parsed.protocol === 'mailto:' &&
    (
      !parsed.pathname.includes('@') ||
      parsed.pathname
        .toLowerCase()
        .endsWith('@localhost')
    )
  ) {
    throw new Error(
      'VAPID_SUBJECT_INVALID: use um endereço de email real.'
    );
  }
}

function validateVapidPair(
  publicKey: string,
  privateKey: string
) {
  let publicBytes: Buffer;
  let privateBytes: Buffer;

  try {
    publicBytes =
      Buffer.from(
        publicKey,
        'base64url'
      );

    privateBytes =
      Buffer.from(
        privateKey,
        'base64url'
      );
  } catch {
    throw new Error(
      'VAPID_KEY_FORMAT_INVALID'
    );
  }

  if (
    privateBytes.length !== 32
  ) {
    throw new Error(
      `VAPID_PRIVATE_KEY_INVALID_LENGTH:${privateBytes.length}`
    );
  }

  if (
    publicBytes.length !== 65
  ) {
    throw new Error(
      `VAPID_PUBLIC_KEY_INVALID_LENGTH:${publicBytes.length}`
    );
  }

  const ecdh =
    createECDH(
      'prime256v1'
    );

  try {
    ecdh.setPrivateKey(
      privateBytes
    );
  } catch {
    throw new Error(
      'VAPID_PRIVATE_KEY_INVALID'
    );
  }

  const derivedPublic =
    ecdh.getPublicKey(
      undefined,
      'uncompressed'
    );

  if (
    derivedPublic.length !==
      publicBytes.length ||
    !timingSafeEqual(
      derivedPublic,
      publicBytes
    )
  ) {
    throw new Error(
      'VAPID_PUBLIC_PRIVATE_MISMATCH'
    );
  }
}

export function getWebPush() {
  const publicKey =
    cleanEnv(
      process.env
        .NEXT_PUBLIC_VAPID_PUBLIC_KEY
    );

  const privateKey =
    cleanEnv(
      process.env
        .VAPID_PRIVATE_KEY
    );

  const subject =
    cleanEnv(
      process.env
        .VAPID_SUBJECT
    );

  if (!publicKey) {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY_MISSING'
    );
  }

  if (!privateKey) {
    throw new Error(
      'VAPID_PRIVATE_KEY_MISSING'
    );
  }

  if (!subject) {
    throw new Error(
      'VAPID_SUBJECT_MISSING'
    );
  }

  validateSubject(
    subject
  );

  validateVapidPair(
    publicKey,
    privateKey
  );

  webpush.setVapidDetails(
    subject,
    publicKey,
    privateKey
  );

  return webpush;
}
