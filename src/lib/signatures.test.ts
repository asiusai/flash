import { describe, expect, it } from 'vitest'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { verifySignature } from './manifest'

describe('release signatures', () => {
  it('verifies ML-DSA-65 and rejects modified manifests, wrong keys, and classical signatures', async () => {
    const key = ml_dsa65.keygen(new Uint8Array(32).fill(7))
    const payload = new TextEncoder().encode('{"version":"test"}')
    const signature = ml_dsa65.sign(payload, key.secretKey)
    await expect(verifySignature(payload, signature, key.publicKey)).resolves.toBeUndefined()
    await expect(verifySignature(new Uint8Array([...payload, 32]), signature, key.publicKey)).rejects.toThrow()
    await expect(verifySignature(payload, signature, ml_dsa65.keygen(new Uint8Array(32).fill(8)).publicKey)).rejects.toThrow()
    await expect(verifySignature(payload, new Uint8Array(64), key.publicKey)).rejects.toThrow()
  })
})
