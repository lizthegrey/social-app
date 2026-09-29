import {
  findMetaRefresh,
  MAX_POW_DIFFICULTY,
  parseAnubisChallenge,
  type ParsedPageMeta,
  parsePageMeta,
  parseRefresh,
  solveProofOfWork,
} from '#/lib/link-meta/anubis/util'

export {isAnubisChallengeTitle} from '#/lib/link-meta/anubis/util'

/**
 * Fetches `url` from the user's device and extracts link card metadata,
 * solving an Anubis challenge along the way if the site presents one - the
 * same work the user's browser would do if they visited the page.
 *
 * This has to run on-device end to end: the pass cookie Anubis issues is bound
 * to the client's IP by default, so it can't be handed to cardyb.
 *
 * Relies on the native HTTP stack's cookie jar to carry Anubis's cookies
 * between requests, as a browser would.
 */
export async function fetchLinkMetaViaAnubis(
  url: string,
  signal: AbortSignal,
): Promise<ParsedPageMeta | undefined> {
  let res = await fetchHtml(url, signal)
  const pageUrl = res.url || url
  let html = await res.text()

  const challenge = parseAnubisChallenge(html)
  if (challenge) {
    const passUrl = new URL(
      `${parseBasePrefix(html)}/.within.website/x/cmd/anubis/api/pass-challenge`,
      pageUrl,
    )
    const {pathname, search} = new URL(pageUrl)

    if (challenge.algorithm === 'metarefresh') {
      const refresh =
        parseRefresh(res.headers.get('refresh')) ??
        parseRefresh(findMetaRefresh(html))
      if (!refresh) return
      await sleep(refresh.delaySeconds * 1e3, signal)
      res = await fetchHtml(new URL(refresh.url, pageUrl).toString(), signal)
      html = await res.text()
    } else if (
      challenge.algorithm === 'fast' ||
      challenge.algorithm === 'slow'
    ) {
      if (challenge.difficulty > MAX_POW_DIFFICULTY) return
      const start = Date.now()
      const {nonce, hash} = await solveProofOfWork(
        challenge.randomData,
        challenge.difficulty,
        signal,
      )
      if (challenge.id) passUrl.searchParams.set('id', challenge.id)
      passUrl.searchParams.set('response', hash)
      passUrl.searchParams.set('nonce', String(nonce))
      passUrl.searchParams.set('redir', pathname + search)
      passUrl.searchParams.set('elapsedTime', String(Date.now() - start))
      res = await fetchHtml(passUrl.toString(), signal)
      html = await res.text()
    } else {
      // e.g. the "preact" challenge, which needs a real DOM
      return
    }

    if (parseAnubisChallenge(html)) {
      // still challenged, e.g. cookies weren't persisted
      return
    }
  }

  // don't make a card out of a 404 or error page
  if (!res.ok) return

  const meta = parsePageMeta(html, pageUrl)
  return meta.title || meta.description || meta.image ? meta : undefined
}

function fetchHtml(url: string, signal: AbortSignal) {
  return fetch(url, {
    signal,
    credentials: 'include',
    headers: {Accept: 'text/html,application/xhtml+xml'},
  })
}

function parseBasePrefix(html: string): string {
  const match = html.match(
    /<script[^>]*\bid=["']anubis_base_prefix["'][^>]*>([\s\S]*?)<\/script>/i,
  )
  if (!match) return ''
  try {
    const prefix: unknown = JSON.parse(match[1])
    return typeof prefix === 'string' ? prefix.replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const to = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(to)
      reject(new Error('Aborted waiting for Anubis refresh'))
    })
  })
}
