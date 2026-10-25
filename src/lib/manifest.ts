import type { FlashManifest, FlashManifestV3, FlashOperation, StorageInfo, StorageProfile } from '../types'

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { UPDATE_PUBLIC_KEY_BASE64 } from './update-key'
const productionKey = Uint8Array.from(atob(UPDATE_PUBLIC_KEY_BASE64), character => character.charCodeAt(0))

const HEX_256 = /^[0-9a-f]{64}$/

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid flash manifest: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function parseOperation(value: unknown, sectorSize: number, diskSize: number): FlashOperation {
  assert(isRecord(value), 'operation must be an object')
  assert(value.operation === 'program' || value.operation === 'erase', 'unsupported chunk operation')
  assert(nonnegativeInteger(value.offset), 'invalid operation offset')
  assert(positiveInteger(value.size), 'chunk size must be positive')
  assert(value.offset % sectorSize === 0 && value.size % sectorSize === 0, 'chunk is not sector-aligned')
  assert(value.offset + value.size <= diskSize, 'operation exceeds the target disk')
  if (value.operation === 'program') {
    assert(typeof value.sha256 === 'string' && HEX_256.test(value.sha256), 'invalid raw chunk hash')
    assert(value.compression === 'xz', 'program chunk must use xz')
    assert(positiveInteger(value.compressed_size), 'invalid compressed chunk size')
    assert(typeof value.compressed_sha256 === 'string' && HEX_256.test(value.compressed_sha256), 'invalid compressed chunk hash')
    assert(typeof value.url === 'string' && new URL(value.url).protocol === 'https:', 'invalid chunk URL')
  }
  return value as FlashOperation
}

function parseStorageProfile(value: unknown): StorageProfile {
  assert(isRecord(value), 'storage profile must be an object')
  assert(typeof value.mem_type === 'string' && value.mem_type.trim().length > 0, 'storage profile must name a memory type')
  for (const key of ['block_size', 'manufacturer_id', 'num_physical', 'page_size', 'total_blocks'] as const) {
    assert(positiveInteger(value[key]), `invalid storage ${key}`)
  }
  assert(typeof value.prod_name === 'string' && value.prod_name.trim().length > 0, 'invalid storage product name')
  return value as StorageProfile
}

export function parseManifest(bytes: Uint8Array): FlashManifest {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  assert(isRecord(value), 'root must be an object')
  assert(value.manifest_version === 3, 'unsupported manifest version')
  assert(value.product === 'asius-v0', 'unsupported product')
  assert(value.sector_size === 4096, 'unsupported sector size')
  assert(positiveInteger(value.chunk_size) && value.chunk_size % value.sector_size === 0, 'invalid chunk size')
  assert(isRecord(value.programmer), 'missing programmer')
  assert(positiveInteger(value.programmer.size), 'invalid programmer size')
  assert(typeof value.programmer.sha256 === 'string' && HEX_256.test(value.programmer.sha256), 'invalid programmer hash')
  assert(typeof value.programmer.url === 'string' && new URL(value.programmer.url).protocol === 'https:', 'invalid programmer URL')
  assert(typeof value.version === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(value.version), 'invalid version')
  assert(value.storage_profiles === undefined || Array.isArray(value.storage_profiles), 'storage profiles must be an array')
  const storageProfiles = value.storage_profiles?.map(parseStorageProfile)

  assert(isRecord(value.base), 'missing base image')
  assert(isRecord(value.base.image), 'missing base image metadata')
  assert(positiveInteger(value.base.image.size) && value.base.image.size % value.sector_size === 0, 'invalid image size')
  assert(Array.isArray(value.base.operations) && value.base.operations.length > 0, 'missing base operations')
  assert(isRecord(value.optional_payloads), 'missing optional payloads')
  assert(isRecord(value.optional_payloads.openpilot), 'missing openpilot payload')
  const openpilot = value.optional_payloads.openpilot
  assert(openpilot.target === 'userdata', 'invalid openpilot payload target')
  assert(typeof openpilot.label === 'string' && openpilot.label.length > 0, 'invalid openpilot payload label')
  assert(typeof openpilot.description === 'string' && openpilot.description.length > 0, 'invalid openpilot payload description')
  assert(isRecord(openpilot.result), 'missing openpilot payload result')
  assert(positiveInteger(openpilot.result.size) && openpilot.result.size % value.sector_size === 0, 'invalid openpilot result size')
  assert(Array.isArray(openpilot.operations) && openpilot.operations.length > 0, 'missing openpilot payload operations')

  const diskSize = value.base.image.size as number
  assert(isRecord(value.persist), 'missing persist protection')
  const { offset, size } = value.persist
  assert(positiveInteger(offset) && positiveInteger(size) && offset % value.sector_size === 0 && size % value.sector_size === 0 && offset + size < diskSize, 'invalid persist range')
  const baseOperations = value.base.operations.map((operation) => parseOperation(operation, value.sector_size as number, diskSize))
  assert(baseOperations[0].operation === 'erase' && baseOperations[0].offset === 0 && baseOperations[0].size === offset, 'base must erase before persist')
  assert(baseOperations[1]?.operation === 'erase' && baseOperations[1].offset === offset + size && baseOperations[1].size === diskSize - offset - size, 'base must erase after persist')
  const openpilotOperations = openpilot.operations.map((operation) => parseOperation(operation, value.sector_size as number, diskSize))

  for (const operation of [...baseOperations, ...openpilotOperations]) {
    assert(operation.offset >= offset + size || operation.offset + operation.size <= offset, 'operation overlaps persist')
  }

  return {
    ...(value as Omit<FlashManifestV3, 'base' | 'optional_payloads' | 'storage_profiles'>),
    base: {
      image: value.base.image as FlashManifestV3['base']['image'],
      operations: baseOperations,
    },
    optional_payloads: {
      openpilot: {
        ...(openpilot as Omit<FlashManifestV3['optional_payloads']['openpilot'], 'operations'>),
        operations: openpilotOperations,
      },
    },
    storage_profiles: storageProfiles,
  }
}

export function parseVamosVersion(bytes: Uint8Array): string {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isRecord(value) || typeof value.version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(value.version)) {
    throw new Error('Invalid signed vamOS release pointer')
  }
  return value.version
}

export async function verifySignature(payload: Uint8Array, signature: Uint8Array, publicKey = productionKey): Promise<void> {
  assert(signature.byteLength === 3309, 'signature must be 3309 bytes')
  assert(publicKey.byteLength === 1952, 'invalid ML-DSA-65 release key')
  if (!ml_dsa65.verify(signature, payload, publicKey)) throw new Error('Flash manifest signature is invalid')
}

export type DownloadTiming = (bytes: number, seconds: number) => void

async function fetchBytes(url: string, cache: RequestCache = 'no-store', onDownload?: DownloadTiming): Promise<Uint8Array> {
  const started = performance.now()
  const requestUrl = import.meta.env.DEV && url.startsWith('https://dist.asius.ai/') ? url.replace('https://dist.asius.ai', '/__updates') : url
  const response = await fetch(requestUrl, { cache, mode: 'cors' })
  if (!response.ok) throw new Error(`Download failed (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  onDownload?.(bytes.length, (performance.now() - started) / 1000)
  return bytes
}

export async function loadSignedBytes(url: string): Promise<Uint8Array> {
  const [payload, signature] = await Promise.all([fetchBytes(url), fetchBytes(`${url}.sig`)])
  await verifySignature(payload, signature)
  return payload
}

export async function loadSignedManifest(url: string): Promise<FlashManifest> {
  const payload = await loadSignedBytes(url)
  return parseManifest(payload)
}

export async function loadSignedVamosVersion(url: string): Promise<string> {
  return parseVamosVersion(await loadSignedBytes(url))
}

export function compatibleStorage(info: StorageInfo, imageSize: number, sectorSize: number): boolean {
  return (
    info.mem_type.trim().toLowerCase() === 'ufs' && sectorSize === 4096 && info.block_size === sectorSize && info.page_size > 0 && info.num_physical > 0 && info.total_blocks * info.block_size >= imageSize && info.prod_name.trim().length > 0
  )
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function downloadVerified(url: string, size: number, digest: string, onDownload?: DownloadTiming): Promise<Uint8Array> {
  const bytes = await fetchBytes(url, 'force-cache', onDownload)
  if (bytes.byteLength !== size) throw new Error(`Downloaded object has the wrong size (${bytes.byteLength}, expected ${size})`)
  if ((await sha256(bytes)) !== digest) throw new Error('Downloaded object failed SHA-256 verification')
  return bytes
}
