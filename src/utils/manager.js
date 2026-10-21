import { BrowserFlasher } from '../lib/flasher'
import { STORAGE_TARGETS } from '../lib/qdl'

export const StepCode = {
  INITIALIZING: 0, READY: 1, DEVICE_PICKER: 2, CONNECTING: 3,
  REPAIR_PARTITION_TABLES: 4, ERASE_DEVICE: 5, FLASH_SYSTEM: 6,
  FINALIZING: 7, DONE: 8,
}
export const DeviceType = { ASIUS_V0: 'asius-v0' }
export const ErrorCode = {
  UNKNOWN: -1, NONE: 0, REQUIREMENTS_NOT_MET: 1, STORAGE_SPACE: 2,
  UNRECOGNIZED_DEVICE: 3, LOST_CONNECTION: 4, REPAIR_PARTITION_TABLES_FAILED: 5,
  ERASE_FAILED: 6, FLASH_SYSTEM_FAILED: 7, FINALIZING_FAILED: 8,
}

// Retain the upstream wizard interface around the Asius release and USB protocol.
export class FlashManager {
  constructor(callbacks = {}) {
    this.callbacks = callbacks
    this.flasher = new BrowserFlasher(status => {
      const steps = {
        release: StepCode.INITIALIZING, ready: StepCode.READY, connect: StepCode.CONNECTING,
        identify: StepCode.REPAIR_PARTITION_TABLES, flash: StepCode.FLASH_SYSTEM,
        reboot: StepCode.FINALIZING, done: StepCode.DONE,
      }
      callbacks.onMessageChange?.(status.error || status.detail)
      callbacks.onProgressChange?.(status.progress)
      callbacks.onStatsChange?.({ elapsedSeconds: status.elapsedSeconds, writeBytesPerSecond: status.writeBytesPerSecond, writeSeconds: status.writeSeconds, downloadSeconds: status.downloadSeconds, downloadBytesPerSecond: status.downloadBytesPerSecond, usbConnection: status.usbConnection })
      if (steps[status.phase] !== undefined) callbacks.onStepChange?.(steps[status.phase])
      if (status.phase === 'ready') callbacks.onReadyChange?.(true)
      if (status.phase === 'error') callbacks.onErrorChange?.(navigator.usb ? ErrorCode.FLASH_SYSTEM_FAILED : ErrorCode.REQUIREMENTS_NOT_MET)
      if (status.serial) callbacks.onSerialChange?.(status.serial)
      if (status.backup) callbacks.onBackupChange?.(status.backup)
      if (['identify', 'flash', 'reboot', 'done'].includes(status.phase)) callbacks.onConnectionChange?.(true)
    })
  }

  initialize() { return this.flasher.prepare(STORAGE_TARGETS[0]) }
  start(choice, flashUboot) {
    this.callbacks.onErrorChange?.(ErrorCode.NONE)
    return this.flasher.run(choice, flashUboot)
  }
}
