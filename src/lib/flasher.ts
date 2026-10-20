import { XzReadableStream } from 'xz-decompress'
import type { FlashChoice, FlashManifest, FlashOperation, FlashStatus } from '../types'
import { compatibleStorage, downloadVerified, loadSignedManifest, loadSignedVamosVersion, sha256 } from './manifest'
import { NOR_TARGET, QdlDevice, type StorageTarget } from './qdl'
import { initializePersist } from './persist'
import { installUboot, loadBootManifest, prepareUboot, readNorBackup, saveNorBackup } from './uboot'

const OPENPILOT_VAMOS_URL = 'https://raw.githubusercontent.com/asiusai/openpilot/master/openpilot/system/hardware/v0/vamos.json'

export function factoryReleaseUrl(version: string, target: StorageTarget): string {
  return `https://vamos.asius.ai/vamos/releases/${version}/flash-${target.label.toLowerCase()}.json`
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'No EDL device was selected. Click Retry to select it.'
  if (error instanceof Error && /claimInterface|claim interface/i.test(error.message)) {
    return 'The operating system has claimed the USB interface. Follow the USB driver instructions, then retry.'
  }
  return error instanceof Error ? error.message : String(error)
}

async function downloadChunk(chunk: FlashOperation): Promise<Uint8Array> {
  if (chunk.operation !== 'program') throw new Error('Expected a program operation')
  const compressed = await downloadVerified(chunk.url, chunk.compressed_size, chunk.compressed_sha256)
  const stream = new XzReadableStream(new Blob([new Uint8Array(compressed).buffer]).stream())
  const raw = new Uint8Array(await new Response(stream).arrayBuffer())
  if (raw.byteLength !== chunk.size) throw new Error('Decompressed chunk has the wrong size')
  if ((await sha256(raw)) !== chunk.sha256) throw new Error('Decompressed chunk failed SHA-256 verification')
  return raw
}

// Hold at most one future block. Capture rejection immediately while USB is busy.
function prefetch(chunk: FlashOperation) {
  return downloadChunk(chunk).then(
    (data) => ({ data, error: undefined }),
    (error) => ({ data: undefined, error }),
  )
}

export class BrowserFlasher {
  private manifest?: FlashManifest
  private programmer?: Uint8Array
  private target?: StorageTarget
  private running = false

  constructor(private readonly onStatus: (status: FlashStatus) => void) {}

  async prepare(target: StorageTarget): Promise<void> {
    if (this.running) throw new Error('A flash is already running')
    this.manifest = undefined
    this.programmer = undefined
    this.target = target
    try {
      if (!navigator.usb) throw new Error('Use Chrome or Edge on a desktop computer with WebUSB support.')
      this.onStatus({ phase: 'release', detail: 'Preparing release...', progress: 0 })
      const localManifest = import.meta.env.DEV ? import.meta.env.VITE_FLASH_MANIFEST_URL : undefined
      const url = localManifest || factoryReleaseUrl(await loadSignedVamosVersion(OPENPILOT_VAMOS_URL), target)
      const manifest = await loadSignedManifest(url)
      if (manifest.sector_size !== target.sectorSize) throw new Error('The release does not match the selected storage type')
      const programmer = await downloadVerified(manifest.programmer.url, manifest.programmer.size, manifest.programmer.sha256)
      this.manifest = manifest
      this.programmer = programmer
      this.onStatus({ phase: 'ready', detail: 'Ready to flash', progress: 0, supportsBaseOnly: true, version: manifest.version })
    } catch (error) {
      this.onStatus({ phase: 'error', detail: 'Release unavailable', progress: 0, error: errorMessage(error) })
    }
  }

  async run(choice: FlashChoice, flashUboot = false): Promise<void> {
    if (this.running) return
    this.running = true
    const started = performance.now()
    let serial: string | undefined
    let backup: FlashStatus['backup']
    let device: QdlDevice | undefined
    const manifest = this.manifest
    const update = (status: FlashStatus) => this.onStatus({ version: manifest?.version, serial, backup, elapsedSeconds: (performance.now() - started) / 1000, ...status })
    const timings: { step: string; seconds: number; bytes?: number }[] = []
    try {
      if (!manifest || !this.programmer || !this.target) throw new Error('The signed release is not ready')
      update({ phase: 'connect', detail: 'Select your device', progress: 0 })
      const bootRequested = flashUboot || choice === 'bootloader'
      device = new QdlDevice(new Uint8Array(this.programmer).buffer, bootRequested ? NOR_TARGET : this.target)
      // Keep requestDevice inside the button's user activation.
      await device.connect()
      serial = device.serial
      timings.push({ step: 'connect', seconds: (performance.now() - started) / 1000 })
      if (bootRequested) {
        update({ phase: 'identify', detail: 'Backing up boot firmware...', progress: 0 })
        const bootManifest = await loadBootManifest()
        const nor = await readNorBackup(device)
        backup = await saveNorBackup(serial, nor)
        update({ phase: 'identify', detail: 'Checking boot firmware...', progress: 0 })
        const boot = await prepareUboot(nor, bootManifest)
        const bootStart = performance.now()
        const detail = boot.changed ? 'Installing U-Boot...' : 'Verifying U-Boot...'
        update({ phase: 'flash', detail, progress: 0 })
        await installUboot(device, boot, (written) => update({ phase: 'flash', detail, progress: written / boot.payload.length }))
        timings.push({ step: 'uboot', seconds: (performance.now() - bootStart) / 1000, bytes: boot.changed ? boot.payload.length : 0 })
        if (choice !== 'bootloader') await device.selectStorage(this.target)
      }
      if (choice !== 'bootloader') {
        update({ phase: 'identify', detail: 'Checking storage...', progress: 0 })
        const storage = await device.getStorageInfo()
        if (!compatibleStorage(storage, manifest.base.image.size, manifest.sector_size)) throw new Error('The UFS storage does not fit this image. UFS was left unchanged.')
      }
      if (choice !== 'bootloader' && (await initializePersist(device, manifest.sector_size, manifest.persist))) {
        await device.erase(manifest.persist.offset, manifest.persist.size)
      }
      const operations = choice === 'bootloader' ? [] : [...manifest.base.operations, ...(choice === 'openpilot' ? manifest.optional_payloads.openpilot.operations : [])]
      const bytesTotal = operations.reduce((sum, op) => sum + (op.operation === 'program' ? op.size : 0), 0)
      const programIndexes = operations.flatMap((op, index) => (op.operation === 'program' ? [index] : []))
      let programIndex = 0
      let pending = programIndexes.length ? prefetch(operations[programIndexes[0]]) : undefined
      let writtenTotal = 0
      for (const operation of operations) {
        const stepStart = performance.now()
        if (operation.operation === 'erase') {
          update({ phase: 'flash', detail: 'Erasing device...', progress: writtenTotal / bytesTotal })
          await device.erase(operation.offset, operation.size)
          timings.push({ step: 'erase', seconds: (performance.now() - stepStart) / 1000 })
          continue
        }
        update({ phase: 'flash', detail: 'Downloading image...', progress: writtenTotal / bytesTotal })
        const result = await pending
        if (!result?.data) throw result?.error || new Error('Missing image block')
        const nextIndex = programIndexes[++programIndex]
        pending = nextIndex === undefined ? undefined : prefetch(operations[nextIndex])
        const writeStart = performance.now()
        timings.push({ step: 'download_wait', seconds: (writeStart - stepStart) / 1000, bytes: operation.compressed_size })
        await device.program(operation.offset, result.data, (bytes) => update({ phase: 'flash', detail: 'Flashing device...', progress: (writtenTotal + bytes) / bytesTotal }))
        timings.push({ step: 'write', seconds: (performance.now() - writeStart) / 1000, bytes: operation.size })
        update({ phase: 'flash', detail: 'Verifying device...', progress: (writtenTotal + operation.size) / bytesTotal })
        const verifyStart = performance.now()
        await device.verify(operation.offset, operation.size, operation.sha256)
        timings.push({ step: 'verify', seconds: (performance.now() - verifyStart) / 1000, bytes: operation.size })
        writtenTotal += operation.size
      }
      update({ phase: 'reboot', detail: 'Finalizing...', progress: 1 })
      await device.reset()
      console.info('Flash timing', JSON.stringify({ seconds: (performance.now() - started) / 1000, bytes: bytesTotal, timings }))
      update({ phase: 'done', detail: 'Your device was flashed successfully!', progress: 1 })
    } catch (error) {
      console.error(error)
      update({ phase: 'error', detail: 'Flashing stopped', progress: 0, error: errorMessage(error) })
    } finally {
      await device?.close()
      this.running = false
    }
  }
}
