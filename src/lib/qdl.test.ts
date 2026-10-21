import { describe, expect, test, vi } from 'vitest'
import { FirehoseClient, NOR_TARGET, QdlDevice, targetMatchesStorage, STORAGE_TARGETS, SaharaClient, logMessages, responseAttributes } from './qdl'

test('write speed includes acknowledgements but excludes time between writes', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(FirehoseClient.prototype, 'configure').mockResolvedValue(undefined)
  vi.spyOn(FirehoseClient.prototype, 'getStorageInfo').mockResolvedValue({
    block_size: 4096, total_blocks: 100, mem_type: 'UFS', manufacturer_id: 0,
    num_physical: 1, page_size: 4096, prod_name: 'test', serial_num: 0,
  })
  vi.spyOn(FirehoseClient.prototype, 'program').mockImplementation(async (_offset, bytes, progress) => {
    now += 1000
    progress(bytes.length)
    now += 1000 // Final acknowledgement also takes time.
  })
  try {
    const device = new QdlDevice(new ArrayBuffer(0), STORAGE_TARGETS[0])
    await device.selectStorage(STORAGE_TARGETS[0])
    expect(device.writeBytesPerSecond).toBeUndefined()
    expect(device.writeSeconds).toBe(0)
    const bytes = new Uint8Array(4096)
    const samples: (number | undefined)[] = []
    await device.program(0, bytes, () => samples.push(device.writeBytesPerSecond))
    expect(samples).toEqual([4096])
    expect(device.writeBytesPerSecond).toBe(2048)
    expect(device.writeSeconds).toBe(2)
    now += 5000 // Downloads and verification must not reduce write throughput.
    expect(device.writeBytesPerSecond).toBe(2048)
    expect(device.writeSeconds).toBe(2)
    await device.program(4096, bytes, () => {})
    expect(device.writeSeconds).toBe(4)
    expect(device.writeBytesPerSecond).toBe(2048)
  } finally { vi.restoreAllMocks() }
})

const encode = (value: string) => new TextEncoder().encode(value)

class TranscriptTransport {
  readonly writes: { bytes: Uint8Array; wait: boolean }[] = []

  constructor(private readonly reads: Uint8Array[]) {}

  async read(): Promise<Uint8Array> {
    const next = this.reads.shift()
    if (!next) throw new Error('Unexpected transcript read')
    return next
  }

  async write(bytes: Uint8Array, wait = true): Promise<void> {
    this.writes.push({ bytes, wait })
  }
}

const document = (body: string) => encode(`<?xml version="1.0" ?><data>${body}</data>`)

const saharaPacket = (...values: number[]) => {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value, true))
  return bytes
}

describe('Firehose XML responses', () => {
  test('supports only UFS storage', () => {
    expect(STORAGE_TARGETS).toEqual([{ label: 'UFS', memoryName: 'UFS', slot: 0, sectorSize: 4096 }])
  })

  test('reads acknowledgement and raw-mode attributes', () => {
    const response = responseAttributes(encode('<?xml version="1.0" ?><data><response value="ACK" rawmode="true" /></data>'))
    expect(response).toEqual({ value: 'ACK', rawmode: 'true' })
  })

  test('waits for a complete response split across USB packets', async () => {
    const transport = new TranscriptTransport([encode('<?xml version="1.0" ?><data><response value="AC'), encode('K" /></data>')])
    await expect(new FirehoseClient(transport, STORAGE_TARGETS[0]).probe()).resolves.toBeUndefined()
  })

  test('drains incoming logs while the command write is pending', async () => {
    let finishWrite: () => void = () => {}
    const written = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const transport = {
      write: vi.fn(() => written),
      read: vi.fn(async () => {
        finishWrite()
        return document('<response value="ACK" />')
      }),
    }
    await expect(new FirehoseClient(transport, STORAGE_TARGETS[0]).probe()).resolves.toBeUndefined()
    expect(transport.write).toHaveBeenCalledOnce()
  })

  test('decodes storage JSON from XML log attributes', () => {
    const logs = logMessages(encode('<?xml version="1.0" ?><data><log value="INFO: {&quot;storage_info&quot;: {&quot;mem_type&quot;: &quot;UFS&quot;}}" /><response value="ACK" /></data>'))
    expect(JSON.parse(logs[0].slice(logs[0].indexOf('{')))).toEqual({ storage_info: { mem_type: 'UFS' } })
  })

  test('keeps reading while the programmer is streaming configure logs', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const transport = new TranscriptTransport([
      ...Array.from({ length: 8 }, (_, index) => document(`<log value="configure log ${index}" />`)),
      document('<log value="INFO: Calling handler for configure" />' + '<log value="INFO: Storage type set to value UFS" />' + '<response value="ACK" MemoryName="UFS" />'),
    ])

    await new FirehoseClient(transport, STORAGE_TARGETS[0]).configure()

    expect(transport.writes).toHaveLength(1)
    expect(transport.writes[0].wait).toBe(true)
    expect(new TextDecoder().decode(transport.writes[0].bytes)).toContain('<configure MemoryName="UFS"')
    expect(debug).toHaveBeenCalledOnce()
    debug.mockRestore()
  })

  test('waits for the configure handler after a preliminary acknowledgement', async () => {
    const transport = new TranscriptTransport([
      document('<response value="ACK" />'),
      document('<log value="INFO: Calling handler for configure" />' + '<log value="INFO: Storage type set to value UFS" />' + '<response value="ACK" MemoryName="UFS" />'),
    ])

    await expect(new FirehoseClient(transport, STORAGE_TARGETS[0]).configure()).resolves.toBeUndefined()
  })

  test('reads unaligned metadata through whole UFS sectors', async () => {
    const raw = new Uint8Array(4096).map((_, index) => index % 251)
    const transport = new TranscriptTransport([document('<response value="ACK" rawmode="true" />'), raw, document('<response value="ACK" rawmode="false" />')])
    const client = new FirehoseClient(transport, STORAGE_TARGETS[0])
    expect(await client.read(4096 + 1024, 1024)).toEqual(raw.slice(1024, 2048))
    expect(new TextDecoder().decode(transport.writes[0].bytes)).toContain('start_sector="1"')
  })

  test('sends sector-aligned erase geometry', async () => {
    const transport = new TranscriptTransport([document('<response value="ACK" />')])

    await new FirehoseClient(transport, STORAGE_TARGETS[0]).erase(4096, 8192)

    const command = new TextDecoder().decode(transport.writes[0].bytes)
    expect(command).toContain('<erase SECTOR_SIZE_IN_BYTES="4096" num_partition_sectors="2"')
    expect(command).toContain('physical_partition_number="0"')
    expect(command).toContain('storage_type="UFS"')
    expect(command).toContain('start_sector="1"')
  })

  test('uses UFS sectors and checks the programmed digest', async () => {
    const hash = 'a'.repeat(64)
    const transport = new TranscriptTransport([document('<log value="Digest ' + hash + '" /><response value="ACK" />')])
    await new FirehoseClient(transport, STORAGE_TARGETS[0]).verify(8192, 4096, hash)
    const command = new TextDecoder().decode(transport.writes[0].bytes)
    expect(command).toContain('SECTOR_SIZE_IN_BYTES="4096"')
    expect(command).toContain('start_sector="2"')
    expect(command).toContain('num_partition_sectors="1"')
  })

  test('rejects mismatched readback and unaligned writes', async () => {
    const transport = new TranscriptTransport([document('<log value="Digest ' + 'b'.repeat(64) + '" /><response value="ACK" />')])
    const client = new FirehoseClient(transport, STORAGE_TARGETS[0])
    await expect(client.verify(0, 4096, 'a'.repeat(64))).rejects.toThrow('SHA-256')
    await expect(client.program(0, new Uint8Array(512), () => {})).rejects.toThrow('Unaligned')
    expect(transport.writes).toHaveLength(1)
  })

  test('keeps only one USB read pending while a long erase is idle', async () => {
    const transport = {
      read: vi.fn(async () => {
        if (transport.read.mock.calls.length > 1) {
          throw new Error('A second USB read was started while the first was pending')
        }
        await new Promise((resolve) => setTimeout(resolve, 1100))
        return document('<response value="ACK" />')
      }),
      write: vi.fn(async () => {}),
    }

    await new FirehoseClient(transport, STORAGE_TARGETS[0]).erase(0, 4096)

    expect(transport.read).toHaveBeenCalledOnce()
  })

  test('recognizes a Sahara packet instead of waiting for a Firehose XML timeout', async () => {
    const transport = new TranscriptTransport([saharaPacket(0x04, 0x10, 0x0d, 1)])

    await expect(new FirehoseClient(transport, STORAGE_TARGETS[0]).probe()).rejects.toThrow('Received Sahara command 0x4 with status 1 while waiting for Firehose XML')
  })

  test('resets a failed Sahara transfer back to hello mode', async () => {
    const transport = new TranscriptTransport([saharaPacket(0x04, 0x10, 0x0d, 1), saharaPacket(0x01, 0x30, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6)])
    const client = new SaharaClient(transport, new ArrayBuffer(0))

    await expect(client.detectMode()).resolves.toBe('sahara')
    expect(Array.from(transport.writes[0].bytes)).toEqual(Array.from(saharaPacket(0x13, 0x08)))
  })
})

test('accepts the programmer NOR storage name only for the NOR target', () => {
  const info = { mem_type: 'NOR', block_size: 4096, total_blocks: 8192, page_size: 4096, num_physical: 0, manufacturer_id: 0, prod_name: '', serial_num: 1663215 }
  expect(targetMatchesStorage(NOR_TARGET, info)).toBe(true)
  expect(targetMatchesStorage(STORAGE_TARGETS[0], info)).toBe(false)
  expect(targetMatchesStorage(NOR_TARGET, { ...info, mem_type: 'UFS' })).toBe(false)
})
