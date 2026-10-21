export type FlashOperation = {
  offset: number
  size: number
} & (
  | { operation: 'erase' }
  | {
      operation: 'program'
      sha256: string
      compressed_sha256: string
      compressed_size: number
      compression: 'xz'
      url: string
    }
)

export type StorageProfile = {
  block_size: number
  manufacturer_id: number
  mem_type: string
  num_physical: number
  page_size: number
  prod_name: string
  total_blocks: number
}

type FlashManifestCommon = {
  chunk_size: number
  product: 'asius-v0'
  programmer: { sha256: string; size: number; url: string }
  sector_size: 4096
  storage_profiles?: StorageProfile[]
  version: string
}

export type FlashManifestV3 = FlashManifestCommon & {
  base: {
    image: { size: number }
    operations: FlashOperation[]
  }
  persist: { offset: number; size: number }
  manifest_version: 3
  optional_payloads: {
    openpilot: {
      description: string
      label: string
      operations: FlashOperation[]
      result: { size: number }
      target: 'userdata'
    }
  }
}

export type FlashManifest = FlashManifestV3

export type StorageInfo = {
  block_size: number
  manufacturer_id: number
  mem_type: string
  num_physical: number
  page_size: number
  prod_name: string
  serial_num: number
  total_blocks: number
}

export type FlashPhase = 'ready' | 'release' | 'connect' | 'identify' | 'flash' | 'reboot' | 'done' | 'error'

export type FlashChoice = 'openpilot' | 'base' | 'bootloader'

export type FlashStatus = {
  phase: FlashPhase
  detail: string
  progress: number
  serial?: string
  supportsBaseOnly?: boolean
  version?: string
  elapsedSeconds?: number
  writeSeconds?: number
  downloadSeconds?: number
  downloadBytesPerSecond?: number
  writeBytesPerSecond?: number
  usbConnection?: string
  backup?: { url: string; name: string }
  error?: string
}
