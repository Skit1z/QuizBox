/** 计算字符串/内容的 SHA-256 哈希（用于附件去重、题目去重） */
export async function sha256(data: string | Blob): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : await data.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
