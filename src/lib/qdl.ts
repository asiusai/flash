import type { StorageInfo } from '../types'
import { WebUsbTransport } from './webusb'

type UsbTransport = Pick<WebUsbTransport, 'read' | 'write'>

export type StorageTarget = {
  label: 'UFS' | 'SPI NOR'
  memoryName: 'UFS' | 'Spinor'
  slot: 0
  sectorSize: 4096
}

export const NOR_TARGET: StorageTarget = { label: 'SPI NOR', memoryName: 'Spinor', slot: 0, sectorSize: 4096 }

export const STORAGE_TARGETS: readonly StorageTarget[] = [{ label: 'UFS', memoryName: 'UFS', slot: 0, sectorSize: 4096 }]

const SAHARA = {
  HELLO_REQUEST: 0x01,
  HELLO_RESPONSE: 0x02,
  END_TRANSFER: 0x04,
  DONE_REQUEST: 0x05,
  DONE_RESPONSE: 0x06,
  COMMAND_READY: 0x0b,
  SWITCH_MODE: 0x0c,
  EXECUTE_REQUEST: 0x0d,
  EXECUTE_RESPONSE: 0x0e,
  EXECUTE_DATA: 0x0f,
  READ_DATA_64: 0x12,
  RESET_STATE_MACHINE: 0x13,
} as const

function packet(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value, true))
  return bytes
}

function command(bytes: Uint8Array): number {
  if (bytes.byteLength < 4) throw new Error('Short Sahara response')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
}

class UsbTimeoutError extends Error {}

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UsbTimeoutError(`USB timed out after ${milliseconds} ms`)), milliseconds)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

function xml(name: string, attributes: Record<string, string | number> = {}): Uint8Array {
  const values = Object.entries(attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')
  return new TextEncoder().encode(`<?xml version="1.0" ?><data><${name}${values ? ` ${values}` : ''} /></data>`)
}

function decodeXml(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

export function responseAttributes(bytes: Uint8Array): Record<string, string> {
  const source = new TextDecoder().decode(bytes)
  const matches = [...source.matchAll(/<response\s+([^>]*?)\/?\s*>/g)]
  const attributes: Record<string, string> = {}
  for (const match of matches) {
    for (const attribute of match[1].matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)) {
      attributes[attribute[1]] = decodeXml(attribute[2])
    }
  }
  return attributes
}

export function logMessages(bytes: Uint8Array): string[] {
  const source = new TextDecoder().decode(bytes)
  return [...source.matchAll(/<log\s+[^>]*value="([^"]*)"[^>]*\/?\s*>/g)].map((match) => decodeXml(match[1]))
}

class SaharaPacketError extends Error {
  constructor(
    readonly saharaCommand: number,
    readonly status?: number,
  ) {
    const suffix = status === undefined ? '' : ` with status ${status}`
    super(`Received Sahara command 0x${saharaCommand.toString(16)}${suffix} while waiting for Firehose XML`)
  }
}

function saharaPacketError(bytes: Uint8Array): SaharaPacketError | undefined {
  if (bytes.byteLength < 8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const saharaCommand = view.getUint32(0, true)
  const packetLength = view.getUint32(4, true)
  if (saharaCommand < SAHARA.HELLO_REQUEST || saharaCommand > SAHARA.RESET_STATE_MACHINE || packetLength < 8 || packetLength > bytes.byteLength) {
    return undefined
  }
  const status = saharaCommand === SAHARA.END_TRANSFER && packetLength >= 16 ? view.getUint32(12, true) : undefined
  return new SaharaPacketError(saharaCommand, status)
}

export class SaharaClient {
  serial = 'unknown'

  constructor(
    private readonly usb: UsbTransport,
    private readonly programmer: ArrayBuffer,
  ) {}

  async detectMode(): Promise<'sahara' | 'firehose' | 'silent'> {
    let initial: Uint8Array
    try {
      initial = await timeout(this.usb.read(48), 2000)
    } catch (error) {
      if (error instanceof UsbTimeoutError) return 'silent'
      throw error
    }
    if (new TextDecoder().decode(initial).includes('<?xml')) return 'firehose'
    const initialCommand = command(initial)
    if (initialCommand === SAHARA.HELLO_REQUEST) return 'sahara'
    if (saharaPacketError(initial)) return this.recoverStateMachine(initialCommand)
    throw new Error('The selected USB device is not in Qualcomm EDL mode')
  }

  async recoverStateMachine(unexpectedCommand: number): Promise<'sahara'> {
    await this.usb.write(packet([SAHARA.RESET_STATE_MACHINE, 0x08]))
    let hello: Uint8Array
    try {
      hello = await timeout(this.usb.read(48), 3000)
    } catch (error) {
      if (error instanceof UsbTimeoutError) {
        throw new Error(`Sahara command 0x${unexpectedCommand.toString(16)} left the device in a failed transfer state; re-enter EDL and try again`)
      }
      throw error
    }
    if (command(hello) !== SAHARA.HELLO_REQUEST) {
      throw new Error(`Sahara reset returned unexpected command 0x${command(hello).toString(16)}`)
    }
    return 'sahara'
  }

  private async hello(mode: number): Promise<void> {
    await this.usb.write(packet([SAHARA.HELLO_RESPONSE, 0x30, 2, 1, 0, mode, 1, 2, 3, 4, 5, 6]))
  }

  private async enterCommandMode(): Promise<void> {
    await this.hello(3)
    const reply = await timeout(this.usb.read(), 2000)
    if (command(reply) !== SAHARA.COMMAND_READY) throw new Error('Sahara command mode was rejected')
  }

  private async readSerial(): Promise<void> {
    await this.usb.write(packet([SAHARA.EXECUTE_REQUEST, 0x0c, 1]))
    const reply = await timeout(this.usb.read(), 2000)
    if (command(reply) !== SAHARA.EXECUTE_RESPONSE || reply.byteLength < 16) {
      throw new Error('Sahara did not return the chip serial length')
    }
    const length = new DataView(reply.buffer, reply.byteOffset, reply.byteLength).getUint32(12, true)
    await this.usb.write(packet([SAHARA.EXECUTE_DATA, 0x0c, 1]))
    const serial = await timeout(this.usb.read(length), 2000)
    const value = new DataView(serial.buffer, serial.byteOffset, serial.byteLength).getUint32(0, true)
    this.serial = `0x${value.toString(16).padStart(8, '0')}`
  }

  async uploadProgrammer(): Promise<void> {
    console.debug('Sahara: entering command mode')
    await this.enterCommandMode()
    console.debug('Sahara: reading chip serial')
    await this.readSerial()
    console.debug(`Sahara: ${this.serial}, entering image-transfer mode`)
    await this.usb.write(packet([SAHARA.SWITCH_MODE, 0x0c, 3]))

    const hello = await timeout(this.usb.read(48), 2000)
    if (command(hello) !== SAHARA.HELLO_REQUEST) throw new Error('Sahara did not return to image-transfer mode')
    await this.hello(0)

    while (true) {
      const reply = await timeout(this.usb.read(), 5000)
      const replyCommand = command(reply)
      const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength)
      if (replyCommand === SAHARA.READ_DATA_64) {
        if (reply.byteLength < 32) throw new Error('Short Sahara programmer request')
        const offset = Number(view.getBigUint64(16, true))
        const length = Number(view.getBigUint64(24, true))
        const payload = new Uint8Array(length)
        if (offset < this.programmer.byteLength) {
          payload.set(new Uint8Array(this.programmer, offset, Math.min(length, this.programmer.byteLength - offset)))
        }
        await this.usb.write(payload)
        continue
      }
      if (replyCommand === SAHARA.END_TRANSFER) {
        if (reply.byteLength < 16 || view.getUint32(12, true) !== 0) throw new Error('Sahara rejected the Firehose programmer')
        await this.usb.write(packet([SAHARA.DONE_REQUEST, 0x08]))
        const done = await timeout(this.usb.read(), 3000)
        if (command(done) !== SAHARA.DONE_RESPONSE) throw new Error('Sahara did not start the Firehose programmer')
        console.debug('Sahara: programmer uploaded')
        return
      }
      throw new Error(`Unexpected Sahara command 0x${replyCommand.toString(16)}`)
    }
  }
}

export class FirehoseClient {
  private readonly maxPayload = 65536

  private get sectorSize(): number {
    return this.target.sectorSize
  }

  constructor(
    private readonly usb: UsbTransport,
    readonly target: StorageTarget,
  ) {}

  private storageAttributes(): Record<string, string | number> {
    return {
      physical_partition_number: 0,
      slot: this.target.slot,
      storage_type: this.target.memoryName,
    }
  }

  private async waitForResponse(inactivityTimeoutMs = 6000): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let receivedBytes = 0
    let receivedPackets = 0
    let source = ''

    // WebUSB transferIn cannot be cancelled. Keep exactly one read outstanding:
    // racing one-second timers would leave abandoned reads behind, and the
    // first abandoned read would consume a delayed response such as a storage erase.
    while (true) {
      try {
        const chunk = await timeout(this.usb.read(), inactivityTimeoutMs)
        if (chunk.byteLength === 0) continue

        chunks.push(chunk)
        receivedBytes += chunk.byteLength
        receivedPackets += 1
        source += new TextDecoder().decode(chunk)

        const unexpectedSahara = saharaPacketError(chunk)
        if (unexpectedSahara) throw unexpectedSahara

        if (/<response\b[^>]*\/>/.test(source)) {
          const combined = new Uint8Array(receivedBytes)
          let offset = 0
          for (const item of chunks) {
            combined.set(item, offset)
            offset += item.byteLength
          }
          if (receivedPackets > 1) console.debug(`Firehose response received after ${receivedPackets} USB packets (${receivedBytes} bytes)`)
          return combined
        }
      } catch (error) {
        if (!(error instanceof UsbTimeoutError)) throw error
        throw new Error(`Firehose response timed out after ${receivedPackets} packet(s) and ${receivedBytes} byte(s)`)
      }
    }
  }

  private async send(commandBytes: Uint8Array, inactivityTimeoutMs = 6000): Promise<Uint8Array> {
    // Drain startup logs while submitting the command. The programmer can
    // block its OUT endpoint until the host consumes pending IN traffic.
    const [reply] = await Promise.all([this.waitForResponse(inactivityTimeoutMs), timeout(this.usb.write(commandBytes), 6000)])
    return reply
  }

  async probe(): Promise<void> {
    const reply = await this.send(xml('nop'))
    if (responseAttributes(reply).value !== 'ACK') throw new Error('The Firehose NOP probe was rejected')
  }

  async configure(): Promise<void> {
    let reply = await this.send(
      xml('configure', {
        MemoryName: this.target.memoryName,
        Verbose: 0,
        AlwaysValidate: 0,
        MaxDigestTableSizeInBytes: 2048,
        MaxPayloadSizeToTargetInBytes: this.maxPayload,
        ZLPAwareHost: 1,
        SkipStorageInit: 0,
        SkipWrite: 0,
      }),
    )
    let response = responseAttributes(reply)
    let logs = logMessages(reply)

    // Some programmers acknowledge receipt before the configure handler runs.
    // qdl.js waits for the handler response, which carries MemoryName.
    if (!('MemoryName' in response)) {
      reply = await this.waitForResponse()
      response = responseAttributes(reply)
      logs = logMessages(reply)
    }

    if (response.value !== 'ACK') throw new Error(`Firehose rejected the ${this.target.label} configuration`)
    if (!logs.some((message) => message.includes('Calling handler for configure'))) {
      throw new Error('The Firehose configure handler did not run')
    }
    if (!logs.some((message) => message.toLowerCase().includes(`storage type set to value ${this.target.memoryName.toLowerCase()}`))) {
      throw new Error(`The connected programmer did not select ${this.target.label} storage`)
    }
  }

  async getStorageInfo(): Promise<StorageInfo> {
    const reply = await this.send(xml('getstorageinfo', this.storageAttributes()))
    if (responseAttributes(reply).value !== 'ACK') throw new Error('Firehose rejected the storage query')
    const line = logMessages(reply).find((message) => message.includes('storage_info'))
    if (!line) throw new Error('The programmer did not return storage identity')
    const parsed = JSON.parse(line.slice(line.indexOf('{'))) as { storage_info?: StorageInfo }
    if (!parsed.storage_info) throw new Error('The programmer returned malformed storage identity')
    return parsed.storage_info
  }

  async program(offset: number, bytes: Uint8Array, onProgress: (written: number) => void): Promise<void> {
    this.checkRange(offset, bytes.byteLength)
    const sectors = bytes.byteLength / this.sectorSize
    const startSector = offset / this.sectorSize
    const begin = await this.send(
      xml('program', {
        SECTOR_SIZE_IN_BYTES: this.sectorSize,
        num_partition_sectors: sectors,
        ...this.storageAttributes(),
        start_sector: startSector,
      }),
    )
    const beginResponse = responseAttributes(begin)
    if (beginResponse.value !== 'ACK' || beginResponse.rawmode !== 'true') {
      throw new Error(`Firehose refused the write at sector ${startSector}`)
    }

    const write = async () => {
      let written = 0
      while (written < bytes.byteLength) {
        const chunk = bytes.subarray(written, written + this.maxPayload)
        await this.usb.write(chunk)
        await this.usb.write(new Uint8Array())
        written += chunk.byteLength
        onProgress(written)
      }
    }
    // NOR programming can take much longer than a metadata operation. Drain
    // logs while writing so the programmer cannot block on its IN endpoint.
    const [end] = await Promise.all([this.waitForResponse(120_000), write()])
    if (responseAttributes(end).value !== 'ACK') throw new Error(`Firehose failed the write at sector ${startSector}`)
  }

  async read(offset: number, size: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024) {
      throw new Error('Invalid Firehose read range')
    }
    const first = Math.floor(offset / this.sectorSize)
    const count = Math.ceil(((offset % this.sectorSize) + size) / this.sectorSize)
    const begin = await this.send(
      xml('read', {
        SECTOR_SIZE_IN_BYTES: this.sectorSize,
        num_partition_sectors: count,
        ...this.storageAttributes(),
        start_sector: first,
      }),
    )
    const response = responseAttributes(begin)
    if (response.value !== 'ACK' || response.rawmode !== 'true') throw new Error('Firehose refused the metadata read')
    const bytes = await timeout(this.usb.read(count * this.sectorSize), 10000)
    if (bytes.byteLength !== count * this.sectorSize) throw new Error('Firehose returned an invalid metadata length')
    const end = await this.waitForResponse()
    if (responseAttributes(end).value !== 'ACK') throw new Error('Firehose failed the metadata read')
    return bytes.slice(offset % this.sectorSize, (offset % this.sectorSize) + size)
  }

  async erase(offset: number, size: number): Promise<void> {
    this.checkRange(offset, size)
    // A large storage erase can legitimately spend minutes without USB
    // traffic. edl-ng allows up to 100 ten-second waits for this command.
    const reply = await this.send(
      xml('erase', {
        SECTOR_SIZE_IN_BYTES: this.sectorSize,
        num_partition_sectors: size / this.sectorSize,
        ...this.storageAttributes(),
        start_sector: offset / this.sectorSize,
      }),
      1_000_000,
    )
    if (responseAttributes(reply).value !== 'ACK') throw new Error(`Firehose failed to erase at byte offset ${offset}`)
  }

  private checkRange(offset: number, size: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(offset + size) || offset % this.sectorSize || size % this.sectorSize) {
      throw new Error('Unaligned or invalid Firehose range')
    }
  }

  async verify(offset: number, size: number, expected: string): Promise<void> {
    this.checkRange(offset, size)
    const reply = await this.send(
      xml('getsha256digest', {
        SECTOR_SIZE_IN_BYTES: this.sectorSize,
        num_partition_sectors: size / this.sectorSize,
        ...this.storageAttributes(),
        start_sector: offset / this.sectorSize,
      }),
      120_000,
    )
    const digest = logMessages(reply)
      .map((line) => /Digest\s+([a-f0-9]{64})/i.exec(line)?.[1]?.toLowerCase())
      .find(Boolean)
    if (responseAttributes(reply).value !== 'ACK' || digest !== expected) {
      throw new Error(`Written data failed SHA-256 verification at byte ${offset}`)
    }
  }

  async reset(): Promise<void> {
    const reply = await this.send(xml('power', { value: 'reset', DelayInSeconds: 1 }))
    if (responseAttributes(reply).value !== 'ACK') throw new Error('Firehose rejected the reset command')
  }
}

export function targetMatchesStorage(target: StorageTarget, storage: StorageInfo): boolean {
  const memory = storage.mem_type.trim().toLowerCase()
  const matches = target.memoryName === 'Spinor' ? memory === 'nor' || memory === 'spinor' : memory === 'ufs'
  return matches && storage.total_blocks > 0 && storage.block_size > 0
}

export class QdlDevice {
  private readonly usb = new WebUsbTransport()
  private firehose?: FirehoseClient
  private storage?: StorageInfo
  serial = 'unknown'

  constructor(
    private readonly programmer: ArrayBuffer,
    private readonly target: StorageTarget,
  ) {}

  async connect(): Promise<void> {
    await this.usb.connect()
    const sahara = new SaharaClient(this.usb, this.programmer)
    const mode = await sahara.detectMode()
    console.debug(`EDL mode: ${mode}`)
    if (mode === 'sahara') {
      await sahara.uploadProgrammer()
      this.serial = sahara.serial
    } else if (mode === 'silent') {
      // A previous attempt may already have uploaded Firehose. It does not
      // speak until prompted, and the timed-out WebUSB read cannot be
      // cancelled, so close/reopen before the active probe.
      await this.usb.reconnect()
      try {
        await new FirehoseClient(this.usb, this.target).probe()
      } catch (error) {
        if (!(error instanceof SaharaPacketError)) throw error
        await sahara.recoverStateMachine(error.saharaCommand)
        await sahara.uploadProgrammer()
        this.serial = sahara.serial
      }
    }

    await this.selectStorage(this.target)
  }

  async selectStorage(target: StorageTarget): Promise<void> {
    this.firehose = undefined
    this.storage = undefined
    const firehose = new FirehoseClient(this.usb, target)
    await firehose.configure()
    const storage = await firehose.getStorageInfo()
    if (!targetMatchesStorage(target, storage) || storage.block_size !== target.sectorSize) {
      throw new Error(`The device does not match the selected ${target.label} storage (${storage.mem_type}, ${storage.block_size}-byte blocks). Nothing was written.`)
    }
    this.firehose = firehose
    this.storage = storage
  }

  private get client(): FirehoseClient {
    if (!this.firehose) throw new Error('Firehose is not connected')
    return this.firehose
  }

  getStorageInfo(): Promise<StorageInfo> {
    if (!this.storage) throw new Error('Firehose storage has not been identified')
    return Promise.resolve(this.storage)
  }

  get storageLabel(): string {
    return this.client.target.label
  }

  program(offset: number, bytes: Uint8Array, onProgress: (written: number) => void): Promise<void> {
    return this.client.program(offset, bytes, onProgress)
  }

  erase(offset: number, size: number): Promise<void> {
    return this.client.erase(offset, size)
  }

  read(offset: number, size: number): Promise<Uint8Array> {
    return this.client.read(offset, size)
  }

  verify(offset: number, size: number, expected: string): Promise<void> {
    return this.client.verify(offset, size, expected)
  }

  reset(): Promise<void> {
    return this.client.reset()
  }

  close(): Promise<void> {
    return this.usb.close()
  }
}
