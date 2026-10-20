declare module 'lzma/src/lzma-d.js' {
  export const LZMA: { decompress(bytes: Uint8Array, callback: (result: number[] | string | null, error?: Error) => void): void }
}
