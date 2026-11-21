/** 复制到独立的 ArrayBuffer，避免 Buffer 的 ArrayBufferLike 与 DOM BlobPart 类型冲突。 */
export const toArrayBuffer = (data: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}
