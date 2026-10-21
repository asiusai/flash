// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from '.'
import { StepCode } from '../utils/manager'

const { start, initialize, manager } = vi.hoisted(() => ({ start: vi.fn(), initialize: vi.fn(), manager: {} }))
vi.mock('../utils/platform', () => ({ isLinux: false, isWindows: false }))
vi.mock('../utils/manager', async importOriginal => {
  const original = await importOriginal()
  return { ...original, FlashManager: class {
    constructor(callbacks) { this.callbacks = callbacks; manager.callbacks = callbacks }
    initialize() { initialize(); this.callbacks.onReadyChange(true) }
    start(...args) { start(...args) }
  } }
})
beforeEach(() => { localStorage.clear(); start.mockClear(); initialize.mockClear() })
afterEach(cleanup)
function connectScreen() {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  fireEvent.click(screen.getByRole('button', { name: 'Asius v0', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

test('remembers all flash options and supports U-Boot alone through Connect', () => {
  connectScreen()
  const toggle = screen.getByRole('checkbox', { name: 'Flash U-Boot' })
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Flash openpilot' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Flash VamOS' }))
  expect(localStorage.getItem('flash-uboot')).toBe('1')
  expect(localStorage.getItem('flash-vamos')).toBe('0')
  expect(localStorage.getItem('flash-openpilot')).toBe('0')
  cleanup()
  connectScreen()
  expect(screen.getByRole('checkbox', { name: 'Flash U-Boot' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Flash VamOS' })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Flash openpilot' })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Flash openpilot' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Update U-Boot only' })).not.toBeInTheDocument()
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1))
  expect(start).toHaveBeenCalledWith('bootloader', true)
})

test('full installation includes openpilot and omits U-Boot by default', () => {
  connectScreen()
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1))
  expect(start).toHaveBeenCalledWith('openpilot', false)
})

test('prevents an empty selection and excludes openpilot when VamOS is off', () => {
  connectScreen()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Flash VamOS' }))
  expect(screen.getByRole('checkbox', { name: 'Flash openpilot' })).not.toBeChecked()
  expect(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1)).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Flash U-Boot' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1))
  expect(start).toHaveBeenCalledWith('bootloader', true)
})

test('can install VamOS without openpilot', () => {
  connectScreen()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Flash openpilot' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1))
  expect(start).toHaveBeenCalledWith('base', false)
})

test('shows elapsed time, measured write speed, USB link, and final duration', () => {
  connectScreen()
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1))
  act(() => {
    manager.callbacks.onStepChange(StepCode.FLASH_SYSTEM)
    manager.callbacks.onMessageChange('Installing software...')
    manager.callbacks.onProgressChange(0.37)
    manager.callbacks.onStatsChange({ elapsedSeconds: 71.8, writeBytesPerSecond: 17_240_000, usbConnection: 'USB 3' })
  })
  expect(screen.getByText('Installing software... (37%)')).toBeInTheDocument()
  expect(screen.getByText('Elapsed')).toBeInTheDocument()
  expect(screen.getByText('1m 11s')).toBeInTheDocument()
  expect(screen.getByText('17.2 MB/s')).toBeInTheDocument()
  expect(screen.getByText('USB 3')).toBeInTheDocument()
  act(() => {
    manager.callbacks.onStepChange(StepCode.DONE)
    manager.callbacks.onMessageChange('Your device was flashed successfully!')
    manager.callbacks.onProgressChange(1)
    manager.callbacks.onStatsChange({ elapsedSeconds: 111.9, writeBytesPerSecond: 17_240_000, usbConnection: 'USB 3' })
  })
  expect(screen.getByText('Flashed in')).toBeInTheDocument()
  expect(screen.getByText('1m 51s')).toBeInTheDocument()
  expect(screen.queryByText(/100%/)).not.toBeInTheDocument()
})

test('works when localStorage is blocked', () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  try {
    connectScreen()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Flash openpilot' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1))
    expect(start).toHaveBeenCalledWith('base', false)
  } finally { get.mockRestore(); set.mockRestore() }
})
