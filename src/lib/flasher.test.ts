import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FlashStatus } from '../types'
import { BrowserFlasher } from './flasher'
import { STORAGE_TARGETS } from './qdl'

const { device, download, boot } = vi.hoisted(() => ({
  device: {
    serial: 'test', usbConnection: 'USB 3', writeBytesPerSecond: undefined as number | undefined,
    connect: vi.fn(), program: vi.fn(), erase: vi.fn(), verify: vi.fn(),
    close: vi.fn(), reset: vi.fn(), selectStorage: vi.fn(), getStorageInfo: vi.fn(),
  },
  download: vi.fn(), boot: vi.fn(),
}))
vi.mock('./qdl', async importOriginal => ({
  ...await importOriginal<typeof import('./qdl')>(),
  QdlDevice: class { constructor() { return device } },
}))
vi.mock('xz-decompress', () => ({ XzReadableStream: class { constructor(stream: ReadableStream) { return stream } } }))
vi.mock('./persist', () => ({ initializePersist: vi.fn().mockResolvedValue(false) }))
vi.mock('./uboot', () => ({
  loadBootManifest: vi.fn(), readNorBackup: vi.fn(), saveNorBackup: vi.fn(),
  prepareUboot: vi.fn().mockResolvedValue({ changed: false, payload: new Uint8Array(4096) }),
  installUboot: boot,
}))
vi.mock('./manifest', () => {
  const chunk = { operation: 'program', offset: 0, size: 4096, sha256: 'hash', compressed_size: 4096, compressed_sha256: 'hash', url: 'chunk' }
  return {
    compatibleStorage: () => true, sha256: async () => 'hash', downloadVerified: download,
    loadSignedVamosVersion: async () => 'test',
    loadSignedManifest: async () => ({
      sector_size: 4096, version: 'test', programmer: { url: 'programmer' }, persist: {},
      base: { image: { size: 8192 }, operations: [{ operation: 'erase', offset: 0, size: 8192 }, chunk] },
      optional_payloads: { openpilot: { operations: [{ ...chunk, offset: 4096 }] } },
    }),
  }
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { usb: {} })
  // Keep stream IO out of the simulated clock; chunk validation has its own tests.
  vi.stubGlobal('Response', class { async arrayBuffer() { return new ArrayBuffer(4096) } })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  device.writeBytesPerSecond = undefined
  device.connect.mockImplementation(async connected => {
    await pause(5000) // Browser chooser time must be excluded.
    connected()
    await pause(1000) // Programmer startup must be included.
  })
  download.mockImplementation(async (_url, _size, _hash, timing) => { timing?.(4096, 0.25); return new Uint8Array(4096) })
  device.program.mockImplementation(async (_offset, bytes, progress) => {
    await pause(1000)
    device.writeBytesPerSecond = bytes.length
    progress(bytes.length)
  })
  device.verify.mockImplementation(() => pause(200))
  device.reset.mockImplementation(() => pause(300))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function prepare() {
  const statuses: FlashStatus[] = []
  const flasher = new BrowserFlasher(status => statuses.push(status))
  await flasher.prepare(STORAGE_TARGETS[0])
  return { statuses, flasher }
}

test('keeps block operations under one status and freezes the full timer after reset', async () => {
  const { statuses, flasher } = await prepare()
  const running = flasher.run('openpilot')
  await vi.advanceTimersByTimeAsync(4000)
  expect(statuses.at(-1)?.elapsedSeconds).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1500)
  expect(statuses.at(-1)).toMatchObject({ elapsedSeconds: 0.5, usbConnection: 'USB 3' })
  await vi.advanceTimersByTimeAsync(4000)
  await running
  expect(device.program).toHaveBeenCalledTimes(2)
  expect(device.verify).toHaveBeenCalledTimes(2)
  expect(new Set(statuses.filter(status => status.phase === 'flash').map(status => status.detail))).toEqual(new Set(['Installing software...']))
  expect(statuses.at(-1)).toMatchObject({ phase: 'done', elapsedSeconds: 3.7, writeBytesPerSecond: 4096, downloadSeconds: 0.5, downloadBytesPerSecond: 16384, usbConnection: 'USB 3' })
  const count = statuses.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(statuses).toHaveLength(count)
  expect(device.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('stops the timer and does not reset or retry after a write fails', async () => {
  const { statuses, flasher } = await prepare()
  device.program.mockImplementation(async () => { await pause(700); throw new Error('Write failed') })
  const running = flasher.run('base')
  await vi.advanceTimersByTimeAsync(8000)
  await running
  expect(statuses.at(-1)).toMatchObject({ phase: 'error', elapsedSeconds: 1.7, error: 'Write failed' })
  const count = statuses.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(statuses).toHaveLength(count)
  expect(device.reset).not.toHaveBeenCalled()
  expect(device.program).toHaveBeenCalledOnce()
  expect(device.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('U-Boot-only verification leaves UFS alone and has no invented write speed', async () => {
  const { statuses, flasher } = await prepare()
  const running = flasher.run('bootloader')
  await vi.advanceTimersByTimeAsync(7000)
  await running
  expect(boot).toHaveBeenCalledOnce()
  expect(device.program).not.toHaveBeenCalled()
  expect(device.erase).not.toHaveBeenCalled()
  expect(device.selectStorage).not.toHaveBeenCalled()
  expect(statuses.at(-1)).toMatchObject({ phase: 'done', elapsedSeconds: 1.3 })
  expect(statuses.at(-1)?.writeBytesPerSecond).toBeUndefined()
})


test.each([['base', false], ['base', true], ['openpilot', false], ['openpilot', true], ['bootloader', true]] as const)('flashes %s with U-Boot %s', async (choice, uboot) => {
  const { statuses, flasher } = await prepare()
  const running = flasher.run(choice, uboot)
  await vi.advanceTimersByTimeAsync(12000)
  await running
  expect(statuses.at(-1)?.phase).toBe('done')
  expect(boot).toHaveBeenCalledTimes(uboot ? 1 : 0)
  expect(device.program.mock.calls.map(call => call[0])).toEqual(choice === 'bootloader' ? [] : choice === 'base' ? [0] : [0, 4096])
  expect(device.erase).toHaveBeenCalledTimes(choice === 'bootloader' ? 0 : 1)
})
