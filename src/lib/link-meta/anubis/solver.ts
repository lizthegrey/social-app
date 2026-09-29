import {type ParsedPageMeta} from '#/lib/link-meta/anubis/util'

export type SolveRequest = {
  id: number
  url: string
  /**
   * Settles the request. Safe to call more than once; only the first call
   * counts.
   */
  finish: (meta: ParsedPageMeta | undefined) => void
}

type Host = (requests: SolveRequest[]) => void

let host: Host | undefined
let pending: SolveRequest[] = []
let nextId = 0

/**
 * Called by `AnubisSolverHost` on mount (and with undefined on unmount) to
 * receive the current set of pages to load.
 */
export function setSolverHost(h: Host | undefined) {
  host = h
  h?.(pending)
}

/**
 * Loads `url` in a hidden WebView so that Anubis's own challenge code runs in
 * a real browser engine on the user's device - exactly as if they'd opened
 * the link themselves - then extracts link card metadata from the page it
 * lets through. Resolves undefined if no host is mounted, the page has no
 * usable metadata, or `signal` aborts first.
 */
export function solveInWebView(
  url: string,
  signal: AbortSignal,
): Promise<ParsedPageMeta | undefined> {
  if (!host || signal.aborted) return Promise.resolve(undefined)

  return new Promise(resolve => {
    let done = false
    const request: SolveRequest = {
      id: nextId++,
      url,
      finish: meta => {
        if (done) return
        done = true
        pending = pending.filter(r => r !== request)
        host?.(pending)
        resolve(meta)
      },
    }
    signal.addEventListener('abort', () => request.finish(undefined))
    pending = [...pending, request]
    host?.(pending)
  })
}
