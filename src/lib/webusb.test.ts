import { afterEach, expect, test, vi } from 'vitest'
import { WebUsbTransport } from './webusb'

afterEach(() => vi.unstubAllGlobals())

test.each([
  [512, 512, 'USB 2'],
  [1024, 1024, 'USB 3'],
  [64, 64, 'USB Full Speed'],
  [512, 1024, 'USB speed unknown'],
  [256, 256, 'USB speed unknown'],
])('reports the active bulk link for %i/%i-byte endpoints', async (inputSize, outputSize, label) => {
  const device = {
    // Capability is deliberately USB 3 even for a negotiated USB 2 link.
    usbVersionMajor: 3,
    opened: true,
    configuration: { interfaces: [{ claimed: true, alternate: { endpoints: [
      { direction: 'in', type: 'bulk', packetSize: inputSize },
      { direction: 'out', type: 'bulk', packetSize: outputSize },
    ] } }] },
    close: vi.fn(),
  }
  vi.stubGlobal('navigator', { usb: { requestDevice: vi.fn().mockResolvedValue(device) } })
  const transport = new WebUsbTransport()
  expect(transport.connectionLabel).toBe('USB speed unknown')
  await transport.connect()
  expect(transport.connectionLabel).toBe(label)
  await transport.close()
  expect(transport.connectionLabel).toBe('USB speed unknown')
})
