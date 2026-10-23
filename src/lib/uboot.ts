import { LZMA } from 'lzma/src/lzma-d.js'
import { downloadVerified, loadSignedBytes, sha256 } from './manifest'
import { crc32 } from './persist'
import { type QdlDevice, NOR_TARGET } from './qdl'

const NOR_SIZE = 32 * 1024 * 1024
const SECTOR = 4096
const PARTITIONS = new Set(['XBL', 'XBL_CONFIG', 'AOP', 'TZ', 'DEVCFG', 'HYP', 'QUP', 'TZAPPS', 'CPUCP', 'SHRM', 'PLAT'])
type Range = { offset: number; size: number }
type Input = Range & { name: string; sha256: string }
type Decoded = Range & { name: string; source: string; output_size: number; sha256: string }
type Copy = Range & { source: string; target: number; xor: number }
export type BootVariant = {
  label: string
  reads: Input[]
  decode: Decoded[]
  copies: Copy[]
  xbl: Range
  template: { url: string; size: number; sha256: string }
  result_sha256: string
}
export type BootManifest = { manifest_version: 1; product: 'asius-v0'; nor_size: number; core_sha256: string; variants: BootVariant[] }

function requireValid(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`U-Boot: ${message}`)
}
function range(value: Range, limit: number) {
  requireValid(Number.isSafeInteger(value.offset) && value.offset >= 0 && Number.isSafeInteger(value.size) && value.size > 0 && value.offset + value.size <= limit, 'invalid firmware range')
}
function hash(value: string) {
  requireValid(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid firmware hash')
}
export function parseBootManifest(bytes: Uint8Array): BootManifest {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as BootManifest
  requireValid(value?.manifest_version === 1 && value.product === 'asius-v0' && value.nor_size === NOR_SIZE, 'unsupported firmware manifest')
  hash(value.core_sha256)
  requireValid(Array.isArray(value.variants) && value.variants.length > 0 && value.variants.length <= 16, 'invalid firmware variants')
  for (const variant of value.variants) {
    range(variant.xbl, NOR_SIZE)
    requireValid(variant.xbl.size === 6 * 1024 * 1024 && variant.xbl.offset % SECTOR === 0, 'invalid XBL geometry')
    range({ offset: 0, size: variant.template.size }, variant.xbl.size)
    requireValid(variant.template.size % SECTOR === 0 && new URL(variant.template.url).protocol === 'https:', 'invalid template')
    hash(variant.template.sha256)
    hash(variant.result_sha256)
    requireValid(Array.isArray(variant.reads) && variant.reads.length === PARTITIONS.size, 'missing boot-chain checks')
    const sources = new Map<string, number>()
    for (const input of variant.reads) {
      range(input, NOR_SIZE)
      hash(input.sha256)
      requireValid(PARTITIONS.has(input.name) && !sources.has(input.name), 'unsupported or duplicate firmware input')
      sources.set(input.name, input.size)
    }
    requireValid(Array.isArray(variant.decode) && variant.decode.length <= 1, 'invalid compressed firmware')
    for (const decoded of variant.decode) {
      requireValid(sources.has(decoded.source) && !sources.has(decoded.name), 'invalid decompression source')
      range(decoded, sources.get(decoded.source)!)
      range({ offset: 0, size: decoded.output_size }, 32 * 1024 * 1024)
      hash(decoded.sha256)
      sources.set(decoded.name, decoded.output_size)
    }
    requireValid(Array.isArray(variant.copies) && variant.copies.length > 0 && variant.copies.length < 64, 'invalid firmware copies')
    const destinations: Range[] = []
    for (const copy of variant.copies) {
      requireValid(sources.has(copy.source) && [0, 0x5a].includes(copy.xor), 'invalid firmware copy source')
      range(copy, sources.get(copy.source)!)
      range({ offset: copy.target, size: copy.size }, variant.template.size)
      requireValid(
        destinations.every((r) => copy.target >= r.offset + r.size || copy.target + copy.size <= r.offset),
        'overlapping firmware copies',
      )
      destinations.push({ offset: copy.target, size: copy.size })
    }
  }
  return value
}

export async function loadBootManifest(): Promise<BootManifest> {
  const url = (import.meta.env.DEV && import.meta.env.VITE_BOOTLOADER_MANIFEST_URL) || 'https://dist.asius.ai/bootloader/uboot.json'
  return parseBootManifest(await loadSignedBytes(url))
}

function norPartitions(nor: Uint8Array): Map<string, Range> {
  requireValid(nor.length === NOR_SIZE, 'incomplete NOR backup')
  const header = nor.slice(SECTOR, 2 * SECTOR)
  requireValid(new TextDecoder().decode(header.subarray(0, 8)) === 'EFI PART', 'invalid NOR GPT')
  const view = new DataView(header.buffer)
  const size = view.getUint32(12, true)
  const checksum = view.getUint32(16, true)
  view.setUint32(16, 0, true)
  requireValid(size >= 92 && size <= SECTOR && crc32(header.subarray(0, size)) === checksum, 'NOR GPT checksum mismatch')
  const lba = Number(view.getBigUint64(72, true))
  const count = view.getUint32(80, true)
  requireValid(lba === 2 && count > 0 && count <= 128 && view.getUint32(84, true) === 128, 'unsupported NOR GPT')
  const entries = nor.subarray(lba * SECTOR, lba * SECTOR + count * 128)
  requireValid(crc32(entries) === view.getUint32(88, true), 'NOR partition checksum mismatch')
  const result = new Map<string, Range>()
  for (let i = 0; i < count; i++) {
    const entry = entries.subarray(i * 128, (i + 1) * 128)
    if (entry.subarray(0, 16).every((byte) => byte === 0)) continue
    const part = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
    const first = Number(part.getBigUint64(32, true))
    const last = Number(part.getBigUint64(40, true))
    const name = new TextDecoder('utf-16le').decode(entry.subarray(56)).replace(/\0+$/, '')
    requireValid(!result.has(name) && first >= 6 && last >= first && last < NOR_SIZE / SECTOR - 5, 'invalid NOR partition')
    result.set(name, { offset: first * SECTOR, size: (last - first + 1) * SECTOR })
  }
  return result
}

async function decompress(bytes: Uint8Array, expected: number): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  requireValid(bytes.length >= 13 && view.getUint32(1, true) <= 32 * 1024 * 1024 && Number(view.getBigUint64(5, true)) === expected, 'invalid LZMA size')
  return new Promise((resolve, reject) =>
    LZMA.decompress(bytes, (result, error) => {
      if (error || typeof result === 'string' || !result || result.length !== expected) reject(error || new Error('Invalid decompressed firmware'))
      else resolve(Uint8Array.from(result))
    }),
  )
}

export async function prepareUboot(nor: Uint8Array, manifest: BootManifest, download = downloadVerified): Promise<{ offset: number; payload: Uint8Array; changed: boolean; norSha256: string }> {
  const parts = norPartitions(nor)
  for (const variant of manifest.variants) {
    const xbl = parts.get('XBL')
    if (!xbl || xbl.offset !== variant.xbl.offset || xbl.size !== variant.xbl.size) continue
    const sources = new Map<string, Uint8Array>()
    let matches = true
    for (const input of variant.reads) {
      const part = parts.get(input.name)
      if (!part || part.offset !== input.offset || (input.name !== 'XBL' ? part.size !== input.size : input.size > part.size)) {
        matches = false
        break
      }
      const data = nor.subarray(input.offset, input.offset + input.size)
      // A current target image is accepted separately after checking every other boot partition.
      if (input.name !== 'XBL' && (await sha256(data)) !== input.sha256) {
        matches = false
        break
      }
      sources.set(input.name, data)
    }
    if (!matches) continue
    const existing = nor.slice(xbl.offset, xbl.offset + variant.template.size)
    if ((await sha256(existing)) === variant.result_sha256) return { offset: xbl.offset, payload: nor.slice(xbl.offset, xbl.offset + xbl.size), changed: false, norSha256: await sha256(nor) }
    if ((await sha256(sources.get('XBL')!)) !== variant.reads.find((r) => r.name === 'XBL')!.sha256) continue
    for (const decoded of variant.decode) {
      const source = sources.get(decoded.source)!
      const data = await decompress(source.subarray(decoded.offset, decoded.offset + decoded.size), decoded.output_size)
      requireValid((await sha256(data)) === decoded.sha256, 'decompressed firmware hash mismatch')
      sources.set(decoded.name, data)
    }
    const template = await download(variant.template.url, variant.template.size, variant.template.sha256)
    const payload = new Uint8Array(template)
    for (const copy of variant.copies) {
      requireValid(
        payload.subarray(copy.target, copy.target + copy.size).every((byte) => byte === 0),
        'template contains device firmware',
      )
      const source = sources.get(copy.source)!
      for (let i = 0; i < copy.size; i++) payload[copy.target + i] = source[copy.offset + i] ^ copy.xor
    }
    requireValid((await sha256(payload)) === variant.result_sha256, 'generated firmware differs from the validated image')
    const complete = nor.slice(xbl.offset, xbl.offset + xbl.size)
    complete.set(payload)
    const expectedNor = nor.slice()
    expectedNor.set(complete, xbl.offset)
    return { offset: xbl.offset, payload: complete, changed: true, norSha256: await sha256(expectedNor) }
  }
  throw new Error('This boot firmware revision is not supported. Nothing was written.')
}

export async function saveNorBackup(serial: string, nor: Uint8Array): Promise<void> {
  const digest = await sha256(nor)
  const name = `asius-${serial.replace(/[^a-zA-Z0-9-]/g, '_')}-nor-${digest.slice(0, 16)}.bin`
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('asius-flash-backups', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('nor')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('nor', 'readwrite')
      tx.objectStore('nor').put(nor, name)
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Cannot save NOR backup'))
    })
    const saved = await new Promise<Uint8Array>((resolve, reject) => {
      const request = database.transaction('nor').objectStore('nor').get(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    requireValid((await sha256(saved)) === digest, 'saved NOR backup verification failed')
  } finally {
    database.close()
  }
}

export async function readNorBackup(device: QdlDevice): Promise<Uint8Array> {
  if (device.storageLabel !== NOR_TARGET.label) await device.selectStorage(NOR_TARGET)
  const info = await device.getStorageInfo()
  requireValid(info.total_blocks * info.block_size === NOR_SIZE, 'unsupported NOR size')
  const nor = new Uint8Array(NOR_SIZE)
  for (let offset = 0; offset < NOR_SIZE; offset += 1024 * 1024) nor.set(await device.read(offset, 1024 * 1024), offset)
  await device.verify(0, NOR_SIZE, await sha256(nor))
  return nor
}

export async function installUboot(device: QdlDevice, prepared: Awaited<ReturnType<typeof prepareUboot>>, onProgress: (written: number) => void): Promise<void> {
  if (device.storageLabel !== NOR_TARGET.label) await device.selectStorage(NOR_TARGET)
  if (prepared.changed) {
    // Match the CLI: program the complete XBL, including its original tail.
    // This preserves board data even when the programmer rounds erase blocks.
    await device.program(prepared.offset, prepared.payload, onProgress)
  }
  await device.verify(prepared.offset, prepared.payload.length, await sha256(prepared.payload))
  await device.verify(0, NOR_SIZE, prepared.norSha256)
}
