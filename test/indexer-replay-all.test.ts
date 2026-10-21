import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { replayAllUnresolvedFailedEvents } from '../src/indexer/replay.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('replayAllUnresolvedFailedEvents', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('returns one outcome per unresolved event, in event_id order, and skips resolved ones', async () => {
    // 'unknown_evt' has no handler, so replay folds it without touching domain state.
    for (const id of ['2-0', '1-0', '3-0']) {
      await query(
        `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
         VALUES ($1, 100, now(), 'CTEST', 'unknown_evt', '[]', '[]')`,
        [id]
      )
    }
    await query(`INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('2-0', 'unknown_evt', 100, 'boom')`)
    await query(`INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('1-0', 'unknown_evt', 100, 'boom')`)
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error, resolved_at) VALUES ('3-0', 'unknown_evt', 100, 'boom', now())`
    )

    const outcomes = await replayAllUnresolvedFailedEvents()
    expect(outcomes).toEqual([
      { eventId: '1-0', status: 'replayed' },
      { eventId: '2-0', status: 'replayed' },
    ])
    expect(await replayAllUnresolvedFailedEvents()).toEqual([])
  })
  it('replays an event whose stored topics/data are not JSON arrays', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('4-0', 100, now(), 'CTEST', 'unknown_evt', '{}', '"scalar"')`
    )
    await query(`INSERT INTO failed_events (event_id, symbol, ledger, error) VALUES ('4-0', 'unknown_evt', 100, 'boom')`)
    expect(await replayAllUnresolvedFailedEvents()).toEqual([{ eventId: '4-0', status: 'replayed' }])
  })
})
