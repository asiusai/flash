// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from '.'

const { start, initialize } = vi.hoisted(() => ({ start: vi.fn(), initialize: vi.fn() }))
vi.mock('../utils/platform', () => ({ isLinux: false, isWindows: false }))
vi.mock('../utils/manager', async importOriginal => {
  const original = await importOriginal()
  return { ...original, FlashManager: class {
    constructor(callbacks) { this.callbacks = callbacks }
    initialize() { initialize(); this.callbacks.onReadyChange(true) }
    start(...args) { start(...args) }
  } }
})
beforeEach(() => { localStorage.clear(); start.mockClear(); initialize.mockClear() })
afterEach(cleanup)
function connectScreen() {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  fireEvent.click(screen.getByRole('button', { name: /Asius v0 UFS/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

test('keeps the optional U-Boot setting across remounts', () => {
  connectScreen()
  const toggle = screen.getByRole('checkbox', { name: 'Install or update U-Boot' })
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  expect(localStorage.getItem('flash-uboot')).toBe('1')
  cleanup()
  connectScreen()
  expect(screen.getByRole('checkbox', { name: 'Install or update U-Boot' })).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Update U-Boot only' }))
  expect(start).toHaveBeenCalledWith('bootloader', true)
})

test('full installation includes openpilot and omits U-Boot by default', () => {
  connectScreen()
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect', exact: true }).at(-1))
  expect(start).toHaveBeenCalledWith('openpilot', false)
})
