import {LINK_META_PROXY} from '#/lib/constants'
import {
  fetchLinkMetaViaWebView,
  isBehindBotChallenge,
  isBotChallengeTitle,
} from '#/lib/link-meta/botChallenge'
import {getGiphyMetaUri} from '#/lib/strings/embed-player'
import {parseStarterPackUri} from '#/lib/strings/starter-pack'
import {type app} from '#/lexicons'
import {isBskyAppUrl} from '../strings/url-helpers'

export enum LikelyType {
  HTML,
  Text,
  Image,
  Video,
  Audio,
  AtpData,
  Other,
}

export interface LinkMeta {
  error?: string
  likelyType: LikelyType
  url: string
  title?: string
  description?: string
  image?: string
  author?: string
  /**
   * The AT-URI of the Atmosphere record representing this external content, if
   * it exists. Example: a site.standard.document record.
   */
  associatedRefs?: app.bsky.embed.external.External['associatedRefs']
  view?: app.bsky.embed.external.View
}

type CardybLinkMetaResponse = {
  error: string
  url: string
  title?: string
  description?: string
  image?: string
  author?: string
  associated_refs?: LinkMeta['associatedRefs']
  view?: LinkMeta['view']
  external_view?: LinkMeta['view']
}

export async function getLinkMeta(
  url: string,
  timeout = 15e3,
): Promise<LinkMeta> {
  if (isBskyAppUrl(url) && !parseStarterPackUri(url)) {
    return {
      likelyType: LikelyType.AtpData,
      url,
    }
  }

  let urlp
  let shouldFollowRedirect = false
  try {
    urlp = new URL(url)

    // Get Giphy meta uri if this is any form of giphy link
    const giphyMetaUri = getGiphyMetaUri(urlp)
    if (giphyMetaUri) {
      url = giphyMetaUri
      urlp = new URL(url)
    }
    // follow redirects for soundcloud shortlinks
    // QUESTION - do we want to follow redirects in other cases? -sfn
    shouldFollowRedirect = urlp.hostname === 'on.soundcloud.com'
  } catch (e) {
    return {
      error: 'Invalid URL',
      likelyType: LikelyType.Other,
      url,
    }
  }
  const likelyType = getLikelyType(urlp)
  const meta: LinkMeta = {
    likelyType,
    url,
  }
  if (likelyType === LikelyType.Image) {
    return meta
  }

  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), timeout || 5e3)

  try {
    const response = await fetch(
      `${LINK_META_PROXY('')}${encodeURIComponent(url)}`,
      {signal: controller.signal},
    )

    const body = (await response.json()) as CardybLinkMetaResponse

    if (body.error !== '') {
      /*
       * e.g. Cloudflare answers cardyb's challenge with a 403. If that's
       * what's going on, try again from the user's device before giving up.
       */
      const fetched = await fetchViaWebView(url, timeout, {probeFirst: true})
      if (!fetched) {
        throw new Error(body.error)
      }
      Object.assign(meta, fetched)
      return meta
    }

    meta.description = body.description
    meta.image = body.image
    meta.author = body.author
    meta.title = body.title
    meta.associatedRefs = body.associated_refs
    meta.view = body.view || body.external_view
    if (shouldFollowRedirect) {
      meta.url = body.url
    }

    if (isBotChallengeTitle(meta.title)) {
      /*
       * cardyb scraped a bot-challenge interstitial. Use what the user's
       * device gets instead, or failing that, drop the interstitial's
       * metadata rather than post a card titled "Making sure you're not a
       * bot!".
       */
      const fetched = await fetchViaWebView(meta.url, timeout)
      meta.title = fetched?.title
      meta.description = fetched?.description
      meta.image = fetched?.image
      meta.author = undefined
      meta.associatedRefs = undefined
      meta.view = undefined
    }
  } catch (e) {
    // failed
    console.error(e)
    meta.error = e instanceof Error ? e.toString() : 'Failed to fetch link'
  } finally {
    clearTimeout(to)
  }

  return meta
}

/**
 * Loads the page in a hidden WebView on the user's device, letting any bot
 * challenge run as it would in their browser. Native only; resolves undefined
 * on web.
 */
async function fetchViaWebView(
  url: string,
  timeout: number,
  {probeFirst = false}: {probeFirst?: boolean} = {},
) {
  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), timeout || 5e3)
  try {
    if (probeFirst && !(await isBehindBotChallenge(url, controller.signal))) {
      return
    }
    return await fetchLinkMetaViaWebView(url, controller.signal)
  } catch (e) {
    console.error(e)
  } finally {
    clearTimeout(to)
  }
}

const IMAGE_PATH_REGEX =
  /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svgz?|tiff?|webp)$/i

export function getLikelyType(url: URL | string): LikelyType {
  if (typeof url === 'string') {
    try {
      url = new URL(url)
    } catch (e) {
      return LikelyType.Other
    }
  }

  return IMAGE_PATH_REGEX.test(url.pathname)
    ? LikelyType.Image
    : LikelyType.HTML
}
