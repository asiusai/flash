import { describe, expect, test } from 'vitest'
import { compatibleStorage, parseManifest, parseVamosVersion } from './manifest'
import type { FlashManifestV3, StorageInfo } from '../types'

const hash = 'a'.repeat(64)
const program = {
  offset: 8192,
  size: 8192,
  sha256: hash,
  operation: 'program' as const,
  compression: 'xz' as const,
  compressed_size: 12,
  compressed_sha256: hash,
  url: 'https://vamos.asius.ai/chunk.img.xz',
}
const manifest: FlashManifestV3 = {
  manifest_version: 3,
  product: 'asius-v0',
  persist: { offset: 24576, size: 4096 },
  version: '18.4',
  sector_size: 4096,
  chunk_size: 8192,
  base: {
    image: { size: 32768 },
    operations: [{ offset: 0, size: 24576, operation: 'erase' }, { offset: 28672, size: 4096, operation: 'erase' }, program],
  },
  optional_payloads: {
    openpilot: {
      label: 'vamOS + openpilot',
      description: 'Prebuilt openpilot',
      target: 'userdata',
      result: { size: 16384 },
      operations: [{ ...program, offset: 16384 }],
    },
  },
  programmer: { size: 10, sha256: hash, url: 'https://vamos.asius.ai/programmer.bin' },
  storage_profiles: [
    {
      mem_type: 'UFS',
      block_size: 4096,
      page_size: 4096,
      num_physical: 1,
      manufacturer_id: 42,
      total_blocks: 1000,
      prod_name: 'TEST UFS',
    },
  ],
}

describe('flash manifest', () => {
  test('reads the factory release version from the signed vamOS pointer', () => {
    expect(parseVamosVersion(new TextEncoder().encode(JSON.stringify({ version: '18.5', manifest_version: 1 })))).toBe('18.5')
    expect(() => parseVamosVersion(new TextEncoder().encode(JSON.stringify({ version: '../latest' })))).toThrow('release pointer')
  })

  test('accepts common base and optional openpilot operations', () => {
    const parsed = parseManifest(new TextEncoder().encode(JSON.stringify(manifest)))
    expect(parsed.product).toBe('asius-v0')
    if (parsed.manifest_version !== 3) throw new Error('expected current manifest')
    expect(parsed.base.operations).toHaveLength(3)
    expect(parsed.optional_payloads.openpilot.operations).toHaveLength(1)
  })

  test('rejects NVMe geometry and legacy manifests', () => {
    expect(() => parseManifest(new TextEncoder().encode(JSON.stringify({ ...manifest, sector_size: 512 })))).toThrow('unsupported sector size')
    expect(() => parseManifest(new TextEncoder().encode(JSON.stringify({ ...manifest, manifest_version: 1 })))).toThrow('unsupported manifest version')
  })

  test('rejects erasing the protected identity range', () => {
    const invalid = structuredClone(manifest)
    invalid.base.operations[0].size = 32768
    expect(() => parseManifest(new TextEncoder().encode(JSON.stringify(invalid)))).toThrow('before persist')
  })

  test('rejects optional writes into persist', () => {
    const invalid = structuredClone(manifest)
    invalid.optional_payloads.openpilot.operations = [{ ...program, offset: 24576, size: 4096 }]
    expect(() => parseManifest(new TextEncoder().encode(JSON.stringify(invalid)))).toThrow('overlaps persist')
  })

  test('rejects an operation beyond the target disk', () => {
    const invalid = structuredClone(manifest)
    invalid.optional_payloads.openpilot.operations[0].offset = 28672
    expect(() => parseManifest(new TextEncoder().encode(JSON.stringify(invalid)))).toThrow('exceeds')
  })

  test('accepts any supported 4096-byte storage with enough capacity', () => {
    const info: StorageInfo = {
      ...manifest.storage_profiles![0],
      prod_name: 'TEST UFS       ',
      serial_num: 1,
    }
    expect(compatibleStorage(info, 32768, 4096)).toBe(true)
    expect(compatibleStorage({ ...info, mem_type: 'NVMe' }, 32768, 4096)).toBe(false)
    expect(compatibleStorage({ ...info, block_size: 512 }, 32768, 4096)).toBe(false)
    expect(compatibleStorage({ ...info, total_blocks: 7 }, 32768, 4096)).toBe(false)
  })

  test('accepts manifests without a storage SKU allowlist', () => {
    const generic = structuredClone(manifest)
    delete generic.storage_profiles
    expect(parseManifest(new TextEncoder().encode(JSON.stringify(generic))).storage_profiles).toBeUndefined()
  })
})
