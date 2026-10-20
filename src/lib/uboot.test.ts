import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { sha256 } from './manifest'
import { crc32 } from './persist'
import { type BootManifest, parseBootManifest, prepareUboot } from './uboot'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
async function fixture() {
  const nor = new Uint8Array(32 * 1024 * 1024)
  const names = ['XBL', 'XBL_CONFIG', 'AOP', 'TZ', 'DEVCFG', 'HYP', 'QUP', 'TZAPPS', 'CPUCP', 'SHRM', 'PLAT']
  const reads = []
  for (const [index, name] of names.entries()) {
    const start = index === 0 ? 256 : 1792 + index
    const size = index === 0 ? 1536 : 1
    const entry = new DataView(nor.buffer, 8192 + index * 128, 128)
    entry.setUint8(0, 1)
    entry.setBigUint64(32, BigInt(start), true)
    entry.setBigUint64(40, BigInt(start + size - 1), true)
    Array.from(name).forEach((char, i) => entry.setUint16(56 + i * 2, char.charCodeAt(0), true))
    nor.fill(index + 1, start * 4096, (start + 1) * 4096)
    reads.push({ name, offset: start * 4096, size: 4096, sha256: await sha256(nor.subarray(start * 4096, (start + 1) * 4096)) })
  }
  const header = new DataView(nor.buffer, 4096, 4096)
  nor.set(new TextEncoder().encode('EFI PART'), 4096)
  header.setUint32(12, 92, true)
  header.setBigUint64(72, 2n, true)
  header.setUint32(80, 128, true)
  header.setUint32(84, 128, true)
  header.setUint32(88, crc32(nor.subarray(8192, 8192 + 128 * 128)), true)
  header.setUint32(16, crc32(nor.subarray(4096, 4096 + 92)), true)
  const template = new Uint8Array(4096)
  template[0] = 42
  const expected = template.slice()
  expected.fill(1, 64, 80)
  const manifest: BootManifest = {
    manifest_version: 1,
    product: 'asius-v0',
    nor_size: nor.length,
    core_sha256: 'a'.repeat(64),
    variants: [
      {
        label: 'test',
        reads,
        decode: [],
        xbl: { offset: 256 * 4096, size: 6 * 1024 * 1024 },
        template: { url: 'https://example.test/uboot.bin', size: template.length, sha256: await sha256(template) },
        result_sha256: await sha256(expected),
        copies: [{ source: 'XBL', offset: 100, size: 16, target: 64, xor: 0 }],
      },
    ],
  }
  return { nor, manifest, template, expected }
}

test('reconstructs verified firmware and leaves original NOR unchanged', async () => {
  const { nor, manifest, template, expected } = await fixture()
  const before = await sha256(nor)
  const result = await prepareUboot(nor, parseBootManifest(encode(manifest)), async () => template)
  expect(result.payload.subarray(0, expected.length)).toEqual(expected)
  expect(await sha256(result.payload.subarray(expected.length))).toBe(await sha256(nor.subarray(result.offset + expected.length, result.offset + result.payload.length)))
  expect(result.changed).toBe(true)
  expect(await sha256(nor)).toBe(before)
  nor.set(result.payload, result.offset)
  expect((await prepareUboot(nor, manifest)).changed).toBe(false)
})

test('rejects an unrecognized boot-chain revision before downloading a template', async () => {
  const { nor, manifest } = await fixture()
  nor[manifest.variants[0].reads[4].offset] ^= 1
  await expect(
    prepareUboot(nor, manifest, async () => {
      throw new Error('must not download')
    }),
  ).rejects.toThrow('not supported')
})

test('rejects damaged GPT and malformed copy ranges', async () => {
  const { nor, manifest } = await fixture()
  nor[8192] ^= 1
  await expect(prepareUboot(nor, manifest)).rejects.toThrow('checksum')
  manifest.variants[0].copies[0].target = 4096
  expect(() => parseBootManifest(encode(manifest))).toThrow('range')
})

test('rejects a generated image with the wrong digest', async () => {
  const { nor, manifest, template } = await fixture()
  template[0] ^= 1
  await expect(prepareUboot(nor, manifest, async () => template)).rejects.toThrow('validated image')
})

test('rejects duplicate or missing boot-chain checks', async () => {
  const { manifest } = await fixture()
  manifest.variants[0].reads[1].name = 'XBL'
  expect(() => parseBootManifest(encode(manifest))).toThrow('duplicate')
})

// Reference dumps stay outside Git. This opt-in integration test proves that
// stock UEFI decompression and installed-U-Boot conversion match the CLI image.
describe.skipIf(!process.env.UBOOT_REFERENCE_DIR)('private firmware fixtures', () => {
  test('matches the signed expected output for every reference', async () => {
    const root = process.env.UBOOT_REFERENCE_DIR!
    const manifest = parseBootManifest(new Uint8Array(await readFile(join(root, 'uboot.json'))))
    const paths = JSON.parse(await readFile(join(root, 'references.json'), 'utf8')) as string[]
    for (const path of paths) {
      const nor = new Uint8Array(await readFile(path))
      const before = await sha256(nor)
      const result = await prepareUboot(nor, manifest, async (url) => new Uint8Array(await readFile(join(root, basename(url)))))
      expect(result.payload.length).toBeGreaterThan(1024 * 1024)
      expect(await sha256(nor)).toBe(before)
      nor.set(result.payload, result.offset)
      expect((await prepareUboot(nor, manifest)).changed).toBe(false)
    }
  }, 120000)
})
