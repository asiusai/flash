import type { QdlDevice } from './qdl'

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

export async function initializePersist(device: Pick<QdlDevice, 'read'>, sectorSize: number, persist: { offset: number; size: number }): Promise<boolean> {
  const header = await device.read(sectorSize, sectorSize)
  // A blank GPT can also be an interrupted flash. Never erase identity here.
  if (header.every((byte) => byte === 0)) return false
  if (new TextDecoder().decode(header.subarray(0, 8)) !== 'EFI PART') throw new Error('Invalid GPT. Device identity was left unchanged.')
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const headerSize = view.getUint32(12, true)
  if (view.getUint32(8, true) !== 0x10000 || headerSize < 92 || headerSize > sectorSize) throw new Error('Unsupported GPT header')
  const checksum = view.getUint32(16, true)
  view.setUint32(16, 0, true)
  if (crc32(header.subarray(0, headerSize)) !== checksum) throw new Error('GPT header checksum mismatch')
  const tableLba = Number(view.getBigUint64(72, true))
  const count = view.getUint32(80, true)
  const entrySize = view.getUint32(84, true)
  if (tableLba !== 2 || count < 6 || count > 128 || entrySize !== 128) throw new Error('Unsupported GPT entries')
  const entries = await device.read(tableLba * sectorSize, count * entrySize)
  if (crc32(entries) !== view.getUint32(88, true)) throw new Error('GPT partition checksum mismatch')
  let found = false
  for (let index = 0; index < count; index++) {
    const entry = entries.subarray(index * entrySize, (index + 1) * entrySize)
    if (entry.subarray(0, 16).every((byte) => byte === 0)) continue
    if (new TextDecoder('utf-16le').decode(entry.subarray(56, 128)).replace(/\0+$/, '') !== 'persist') continue
    const part = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
    const start = Number(part.getBigUint64(32, true))
    const end = Number(part.getBigUint64(40, true))
    if (index !== 5 || start * sectorSize !== persist.offset || (end - start + 1) * sectorSize !== persist.size) {
      throw new Error('Existing persist geometry differs. Explicit migration is required.')
    }
    found = true
  }
  if (found) return false
  // Preserve a provisioned filesystem even if an old GPT was restored.
  const superblock = await device.read(persist.offset + 1024, 1024)
  return !(superblock[56] === 0x53 && superblock[57] === 0xef && new TextDecoder().decode(superblock.subarray(120, 136)).replace(/\0+$/, '') === 'VAMOS-IDENTITY')
}
