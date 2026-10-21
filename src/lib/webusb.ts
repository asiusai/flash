const QUALCOMM_VENDOR_ID = 0x05c6
const EDL_PRODUCT_ID = 0x9008

export class WebUsbTransport {
  private device?: USBDevice
  private endpointIn?: USBEndpoint
  private endpointOut?: USBEndpoint
  private packetSize = 512

  get connected(): boolean {
    return Boolean(this.device?.opened && this.device.configuration?.interfaces[0]?.claimed)
  }

  get connectionLabel(): string {
    // The active bulk descriptors reflect the link, unlike bcdUSB, which
    // only describes the device's supported USB specification.
    const size = this.endpointIn?.packetSize
    if (size !== this.endpointOut?.packetSize) return 'USB speed unknown'
    if (size === 1024) return 'USB 3'
    if (size === 512) return 'USB 2'
    if (size && [8, 16, 32, 64].includes(size)) return 'USB Full Speed'
    return 'USB speed unknown'
  }

  async connect(): Promise<void> {
    if (!navigator.usb) throw new Error('WebUSB is not available in this browser')
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: QUALCOMM_VENDOR_ID, productId: EDL_PRODUCT_ID, classCode: 0xff }],
    })
    await this.open(device)
  }

  async reconnect(timeoutMs = 8000): Promise<void> {
    const deadline = performance.now() + timeoutMs
    const previous = this.device
    await this.close()
    while (performance.now() < deadline) {
      const devices = await navigator.usb.getDevices()
      const device = devices.find((candidate) => candidate === previous || (previous?.serialNumber && candidate.serialNumber === previous.serialNumber && candidate.vendorId === QUALCOMM_VENDOR_ID && candidate.productId === EDL_PRODUCT_ID))
      if (device) {
        try {
          await this.open(device)
          return
        } catch {
          // The device can be visible for a moment before its endpoints are ready.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('The device did not reconnect after starting the Firehose programmer')
  }

  async close(): Promise<void> {
    try {
      await this.device?.close()
    } catch {
      // Reset can remove the device before the browser closes its handle.
    }
    this.device = undefined
    this.endpointIn = undefined
    this.endpointOut = undefined
  }

  private async open(device: USBDevice): Promise<void> {
    if (!device.opened) await device.open()
    if (!device.configuration) await device.selectConfiguration(1)
    const usbInterface = device.configuration?.interfaces[0]
    const alternate = usbInterface?.alternate
    if (!usbInterface || !alternate) throw new Error('EDL USB interface is missing')
    if (!usbInterface.claimed) await device.claimInterface(usbInterface.interfaceNumber)

    const endpointIn = alternate.endpoints.find((endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk')
    const endpointOut = alternate.endpoints.find((endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk')
    if (!endpointIn || !endpointOut) throw new Error('EDL bulk endpoints are missing')

    this.device = device
    this.endpointIn = endpointIn
    this.endpointOut = endpointOut
    this.packetSize = endpointIn.packetSize
  }

  async read(length = 0): Promise<Uint8Array> {
    if (!this.device || !this.endpointIn) throw new Error('USB device is not connected')
    if (length > 0) {
      const chunks: Uint8Array[] = []
      let received = 0
      while (received < length) {
        const chunk = await this.read()
        if (chunk.byteLength === 0) continue
        chunks.push(chunk)
        received += chunk.byteLength
      }
      const result = new Uint8Array(received)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
      }
      return result
    }
    const transfer = await this.device.transferIn(this.endpointIn.endpointNumber, this.packetSize)
    if (transfer.status !== 'ok' || !transfer.data) throw new Error(`USB read failed: ${transfer.status}`)
    return new Uint8Array(transfer.data.buffer)
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.device || !this.endpointOut) throw new Error('USB device is not connected')
    const maxTransfer = 65536
    let offset = 0
    do {
      const chunk = data.subarray(offset, offset + maxTransfer)
      offset += chunk.byteLength
      const result = await this.device.transferOut(this.endpointOut.endpointNumber, chunk as Uint8Array<ArrayBuffer>)
      if (result.status !== 'ok' || result.bytesWritten !== chunk.byteLength) throw new Error(`USB write failed: ${result.status}`)
    } while (offset < data.byteLength)
  }
}
