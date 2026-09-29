import {type ParsedPageMeta} from '#/lib/link-meta/anubis/util'

export {isAnubisChallengeTitle} from '#/lib/link-meta/anubis/util'

/**
 * On web, CORS stops us from reading a third-party page's HTML (Anubis sends
 * no CORS headers), and the pass cookie would land in the wrong cookie jar
 * anyway, so there's nothing we can do client-side.
 */
export function fetchLinkMetaViaAnubis(
  _url: string,
  _signal: AbortSignal,
): Promise<ParsedPageMeta | undefined> {
  return Promise.resolve(undefined)
}
