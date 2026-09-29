import {
  getPageTitle,
  isBotChallengeTitle,
} from '#/lib/link-meta/botChallenge/util'

/**
 * Cheaply checks, without running any of the page's JS, whether `url` is
 * behind a bot challenge. Used when cardyb fails outright, so that we only
 * spin up a WebView for pages a browser could plausibly get past - not for
 * every dead link or page cardyb declined to fetch.
 */
export async function isBehindBotChallenge(
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal,
      headers: {Accept: 'text/html,application/xhtml+xml'},
    })
    if (res.headers.get('cf-mitigated') === 'challenge') return true
    return isBotChallengeTitle(getPageTitle(await res.text()))
  } catch {
    return false
  }
}
