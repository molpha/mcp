/**
 * Molpha protocol constants this server hardcodes. They are not configuration: no setting changes
 * them, and `GET /v1/info` does not report them.
 */

/**
 * The round tick, in milliseconds. A gateway stamps every round with its own clock rounded down to
 * a multiple of this, and nodes reject a round whose timestamp is off that grid. Requests for one
 * feed (source, quorum and registry version) inside one tick share one round, so a feed runs at
 * most 10 rounds per second, and one consumer gets at most one round per tick for a feed: a second
 * request inside the same tick is answered with HTTP 409.
 */
export const ROUND_TICK_MS = 100;
