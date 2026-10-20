import { expect, test } from 'vitest'
import { crc32, initializePersist } from './persist'

function fixture(sector: number, withPersist = true) {
  const bytes = new Uint8Array(2 * 1024 * 1024)
  const persist = { offset: 1024 * 1024, size: 65536 }
  const entries = bytes.subarray(2 * sector, 2 * sector + 16384)
  if (withPersist) {
    const part = entries.subarray(5 * 128, 6 * 128)
    part.fill(1, 0, 16)
    const view = new DataView(part.buffer, part.byteOffset, part.byteLength)
    view.setBigUint64(32, BigInt(persist.offset / sector), true)
    view.setBigUint64(40, BigInt((persist.offset + persist.size) / sector - 1), true)
    Array.from('persist').forEach((letter, index) => view.setUint16(56 + index * 2, letter.charCodeAt(0), true))
  }
  const header = bytes.subarray(sector, 2 * sector)
  header.set(new TextEncoder().encode('EFI PART'))
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  view.setUint32(8, 0x10000, true)
  view.setUint32(12, 92, true)
  view.setBigUint64(72, 2n, true)
  view.setUint32(80, 128, true)
  view.setUint32(84, 128, true)
  view.setUint32(88, crc32(entries), true)
  view.setUint32(16, crc32(header.subarray(0, 92)), true)
  const device = { read: async (offset: number, size: number) => bytes.slice(offset, offset + size) }
  return { bytes, persist, device }
}

test.each([512, 4096])('preserves existing identity at sector size %i', async (sector) => {
  const { persist, device } = fixture(sector)
  expect(await initializePersist(device, sector, persist)).toBe(false)
})

test('initializes a new partition on an old GPT', async () => {
  const { persist, device } = fixture(4096, false)
  expect(await initializePersist(device, 4096, persist)).toBe(true)
})

test('preserves identity after interrupted GPT erase', async () => {
  const { bytes, persist, device } = fixture(4096)
  bytes.fill(0, 4096, 8192)
  expect(await initializePersist(device, 4096, persist)).toBe(false)
})

test('rejects moved identity partitions and damaged GPT', async () => {
  const { bytes, persist, device } = fixture(4096)
  await expect(initializePersist(device, 4096, { ...persist, offset: persist.offset + 4096 })).rejects.toThrow('geometry differs')
  bytes[4096 + 20] ^= 1
  await expect(initializePersist(device, 4096, persist)).rejects.toThrow('checksum')
})
