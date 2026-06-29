// 敏感信息（API Key / WebDAV 密码）的本地加密存储。
// 采用 AES-GCM，密钥由本机生成的随机盐 + 固定口令派生。
// 注：纯前端环境无法做到真正的密钥隔离；此方案只避免 IndexedDB 明文落盘，
// 不应被视为能抵御本地攻击者或 XSS。解密失败必须显式暴露，避免凭据被静默清空。

const SALT_KEY = '__qa_salt__'
const ENC_PREFIX = 'enc::'

export class SecretDecryptError extends Error {
  constructor() {
    super('敏感信息解密失败，请重新填写并保存')
    this.name = 'SecretDecryptError'
  }
}

async function getSalt(): Promise<string> {
  let salt = localStorage.getItem(SALT_KEY)
  if (!salt) {
    const arr = crypto.getRandomValues(new Uint8Array(16))
    salt = btoa(String.fromCharCode(...arr))
    localStorage.setItem(SALT_KEY, salt)
  }
  return salt
}

async function deriveKey(): Promise<CryptoKey> {
  const salt = await getSalt()
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode('QAsystem-local-v1:' + salt),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function bufToB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}
function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr.buffer
}

export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return ''
  const key = await deriveKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plain),
  )
  // 拼接 iv + cipher
  const combined = new Uint8Array(iv.length + cipher.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(cipher), iv.length)
  return ENC_PREFIX + bufToB64(combined.buffer)
}

export async function decryptSecret(stored: string): Promise<string> {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored // 兼容旧明文
  try {
    const key = await deriveKey()
    const combined = new Uint8Array(b64ToBuf(stored.slice(ENC_PREFIX.length)))
    const iv = combined.slice(0, 12)
    const cipher = combined.slice(12)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      cipher,
    )
    return new TextDecoder().decode(plain)
  } catch {
    throw new SecretDecryptError()
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX)
}
