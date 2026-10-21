import { rpc } from '@stellar/stellar-sdk'
import { config } from '../config.js'

// Allow http:// for local/standalone RPC while defaulting to secure transport.
// `headers` (issue #284) lets a managed/private RPC provider (QuickNode and
// similar) require an API key or bearer token — only set when
// STELLAR_RPC_HEADERS is non-empty, since passing `headers: {}` is harmless
// but passing `undefined` more clearly reflects "not configured" if the SDK
// ever branches on the option's presence rather than its contents.
const rpcHeaders = config.stellar.rpcHeaders
export const server = new rpc.Server(config.stellar.rpcUrl, {
  allowHttp: config.stellar.rpcUrl.startsWith('http://'),
  ...(Object.keys(rpcHeaders).length > 0 ? { headers: rpcHeaders } : {}),
})

/** Issue #268: Retry with exponential backoff on HTTP 429 rate limit */
async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries = 5
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err: unknown) {
      const isRateLimited =
        (!!err &&
          typeof err === 'object' &&
          (('code' in err && err.code === 429) || ('status' in err && err.status === 429))) ||
        (err instanceof Error && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit')))

      if (!isRateLimited || attempt >= maxRetries) {
        throw err
      }

      attempt++
      // Exponential backoff with jitter: base delay 2^attempt seconds, plus random jitter up to 1s
      const baseDelay = Math.min(1000 * 2 ** attempt, 32000)
      const jitter = Math.random() * 1000
      const delay = baseDelay + jitter

      console.warn(
        `[rpc] ${operation} rate-limited (429), retry ${attempt}/${maxRetries} after ${Math.round(delay)}ms`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

export async function getLatestLedger(): Promise<number> {
  return withRateLimitRetry(
    async () => {
      const res = await server.getLatestLedger()
      return res.sequence
    },
    'getLatestLedger'
  )
}

/** Latest-ledger sequence plus its hash (`id`) — used for the coarse rewind
 *  signal in reorg detection (issue #23). */
export async function getLatestLedgerInfo(): Promise<{ sequence: number; hash: string }> {
  return withRateLimitRetry(
    async () => {
      const res = await server.getLatestLedger()
      return { sequence: res.sequence, hash: res.id }
    },
    'getLatestLedgerInfo'
  )
}

/** Hash of a specific ledger by sequence. Soroban's `getEvents` exposes no
 *  per-event ledger hash, so this is how the poller learns the hash of the
 *  ledger it actually folded to (issue #127) and later re-checks it against
 *  what the RPC reports for that same sequence, to catch a same-height fork
 *  the sequence-only continuity check can't see (issue #128).
 *
 *  Resolves to null — never rejects — when the RPC can't answer: it throws
 *  (rather than returning an empty page) when `sequence` has aged out of its
 *  retention window, and a transient RPC/network error is just as
 *  unanswerable here. Either way, callers must treat null as "unverifiable",
 *  not as evidence of a fork; letting a hiccup on this best-effort check
 *  reject would otherwise wedge fetchOnce in permanent retry over a ledger
 *  whose events may already be safely folded and committed. */
export async function getLedgerHash(sequence: number): Promise<string | null> {
  try {
    const res = await server.getLedgers({ startLedger: sequence, pagination: { limit: 1 } })
    return res.ledgers[0]?.hash ?? null
  } catch {
    return null
  }
}
