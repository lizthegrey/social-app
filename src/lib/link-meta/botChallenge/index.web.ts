import {type ParsedPageMeta} from '#/lib/link-meta/botChallenge/util'

export {isBotChallengeTitle} from '#/lib/link-meta/botChallenge/util'

/**
 * On web, CORS stops us from reading a third-party page's HTML (challenge
 * pages send no CORS headers), and an iframe's contents are just as opaque to
 * us, so there's nothing we can do client-side.
 */
export function fetchLinkMetaViaWebView(
  _url: string,
  _signal: AbortSignal,
): Promise<ParsedPageMeta | undefined> {
  return Promise.resolve(undefined)
}

export function isBehindBotChallenge(
  _url: string,
  _signal: AbortSignal,
): Promise<boolean> {
  return Promise.resolve(false)
}
