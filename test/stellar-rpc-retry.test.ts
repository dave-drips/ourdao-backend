import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLatestLedger, server } from '../src/stellar/rpc.js'

// Drives the real withRateLimitRetry through getLatestLedger (issue #268).
describe('withRateLimitRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const ok = { sequence: 42 } as Awaited<ReturnType<typeof server.getLatestLedger>>

  it.each([
    ['{ code: 429 }', { code: 429 }],
    ['{ status: 429 }', { status: 429 }],
    ['an Error mentioning 429', new Error('429 Too Many Requests')],
    ['an Error mentioning rate limit', new Error('Rate Limit exceeded')],
  ])('retries on %s and returns the eventual result', async (_label, err) => {
    const spy = vi.spyOn(server, 'getLatestLedger').mockRejectedValueOnce(err).mockResolvedValueOnce(ok)
    const result = getLatestLedger()
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBe(42)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a plain Error', new Error('boom')],
    ['an object with another code', { code: 500 }],
    ['null', null],
  ])('does not retry %s', async (_label, err) => {
    const spy = vi.spyOn(server, 'getLatestLedger').mockRejectedValue(err)
    await expect(getLatestLedger()).rejects.toBe(err)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxRetries and rethrows', async () => {
    const err = { status: 429 }
    const spy = vi.spyOn(server, 'getLatestLedger').mockRejectedValue(err)
    const result = getLatestLedger().catch((e) => e)
    await vi.runAllTimersAsync()
    expect(await result).toBe(err)
    expect(spy).toHaveBeenCalledTimes(6) // initial attempt + 5 retries
  })
})
