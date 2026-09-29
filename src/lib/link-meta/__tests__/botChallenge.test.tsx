import {act, render} from '@testing-library/react-native'

import {BotChallengeSolverHost} from '#/lib/link-meta/botChallenge/BotChallengeSolverHost'
import {isBehindBotChallenge} from '#/lib/link-meta/botChallenge/probe'
import {
  setSolverHost,
  solveInWebView,
  type SolveRequest,
} from '#/lib/link-meta/botChallenge/solver'
import {
  decodeHtmlEntities,
  getPageTitle,
  isBotChallengeTitle,
  parsePageMeta,
} from '#/lib/link-meta/botChallenge/util'
import {getLinkMeta} from '#/lib/link-meta/link-meta'

type WebViewProps = {
  source: {uri: string}
  onMessage: (e: {nativeEvent: {data: string}}) => void
  onLoadStart: () => void
  onHttpError: () => void
  onError: () => void
}

const mockWebViews: WebViewProps[] = []
jest.mock('react-native-webview', () => ({
  WebView: (props: WebViewProps) => {
    mockWebViews.push(props)
    return null
  },
}))

const REAL_HEAD = `<head>
<title>Fallback title</title>
<meta property="og:title" content="Fedora Forge &amp; friends">
<meta content="A self-hosted forge." name="description">
<meta property='og:image' content='/assets/img/logo.png'>
</head>`

const REAL_META = {
  title: 'Fedora Forge & friends',
  description: 'A self-hosted forge.',
  image: 'https://forge.example/assets/img/logo.png',
}

const ANUBIS_HEAD = `<head><title>Making sure you&#39;re not a bot!</title></head>`
const CLOUDFLARE_HEAD = `<head><title>Just a moment...</title></head>`

function fakeResponse(
  body: string,
  {headers = {}}: {headers?: Record<string, string>} = {},
) {
  return {
    ok: true,
    headers: {get: (k: string) => headers[k.toLowerCase()] ?? null},
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  }
}

const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit?]>()

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  setSolverHost(undefined)
  mockWebViews.length = 0
})

describe('isBotChallengeTitle', () => {
  it.each([
    ["Making sure you're not a bot!", true],
    ['Making sure you&#39;re not a bot!', true],
    // as stored in a real post's embed record
    ['Making sure you&apos;re not a bot!', true],
    ['Making sure you’re not a bot!', true],
    ['  Dein Browser wird geprüft!  ', true],
    ['正在确认你是不是机器人！', true],
    ['Just a moment...', true],
    ['Just a moment…', true],
    ['Just a moment', false],
    ['GNOME / gtk · GitLab', false],
    ['', false],
    [undefined, false],
  ])('%p -> %p', (title, expected) => {
    expect(isBotChallengeTitle(title)).toBe(expected)
  })
})

describe('getPageTitle', () => {
  it.each([
    [ANUBIS_HEAD, "Making sure you're not a bot!"],
    [
      // Anubis with OpenGraph passthrough: the <title> still gives it away
      `<head><title>Making sure you&#39;re not a bot!</title><meta property="og:title" content="Real"></head>`,
      "Making sure you're not a bot!",
    ],
    ['<head></head>', undefined],
  ])('%p', (html, expected) => {
    expect(getPageTitle(html)).toBe(expected)
  })
})

describe('parsePageMeta', () => {
  it.each([
    ['og tags, relative image, attribute order', REAL_HEAD, REAL_META],
    [
      'falls back to title tag and twitter image',
      `<head><title>Plain &lt;title&gt;</title><meta name="twitter:image" content="https://cdn.example/i.png"></head>`,
      {
        title: 'Plain <title>',
        description: undefined,
        image: 'https://cdn.example/i.png',
      },
    ],
    [
      'ignores tags after </head>',
      `<head><title>T</title></head><body><meta property="og:title" content="nope"></body>`,
      {title: 'T', description: undefined, image: undefined},
    ],
    [
      'drops non-http images',
      `<head><title>T</title><meta property="og:image" content="file:///data/secret.png"></head>`,
      {title: 'T', description: undefined, image: undefined},
    ],
    ['an Anubis interstitial is not metadata', ANUBIS_HEAD, undefined],
    ['a Cloudflare interstitial is not metadata', CLOUDFLARE_HEAD, undefined],
    ['empty page', '', undefined],
  ])('%s', (_name, html, expected) => {
    expect(parsePageMeta(html, 'https://forge.example/repo')).toEqual(expected)
  })
})

describe('decodeHtmlEntities', () => {
  it.each([
    ['a &amp; b', 'a & b'],
    ['&#39;&#x27;&apos;', "'''"],
    ['&bogus; &#xZZ;', '&bogus; &#xZZ;'],
  ])('%p', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected)
  })
})

describe('isBehindBotChallenge', () => {
  it.each([
    [
      'cf-mitigated header',
      fakeResponse('<title>x</title>', {
        headers: {'cf-mitigated': 'challenge'},
      }),
      true,
    ],
    ['Anubis title', fakeResponse(ANUBIS_HEAD), true],
    ['Cloudflare title', fakeResponse(CLOUDFLARE_HEAD), true],
    ['ordinary page', fakeResponse(REAL_HEAD), false],
  ])('%s -> %p', async (_name, response, expected) => {
    fetchMock.mockResolvedValueOnce(response)
    await expect(
      isBehindBotChallenge('https://a.example/', new AbortController().signal),
    ).resolves.toBe(expected)
  })

  it('is false when the fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(
      isBehindBotChallenge('https://a.example/', new AbortController().signal),
    ).resolves.toBe(false)
  })
})

describe('solveInWebView', () => {
  it('resolves undefined when no host is mounted', async () => {
    await expect(
      solveInWebView('https://a.example/', new AbortController().signal),
    ).resolves.toBeUndefined()
  })

  it('hands requests to the host and settles them once', async () => {
    const host = jest.fn<void, [SolveRequest[]]>()
    setSolverHost(host)
    const promise = solveInWebView(
      'https://a.example/',
      new AbortController().signal,
    )

    const [request] = host.mock.lastCall![0]
    expect(request.url).toBe('https://a.example/')

    request.finish(REAL_META)
    request.finish(undefined)
    await expect(promise).resolves.toEqual(REAL_META)
    expect(host).toHaveBeenLastCalledWith([])
  })

  it('drops the request on abort', async () => {
    const host = jest.fn()
    setSolverHost(host)
    const controller = new AbortController()
    const promise = solveInWebView('https://a.example/', controller.signal)
    expect(host).toHaveBeenLastCalledWith([
      expect.objectContaining({url: 'https://a.example/'}),
    ])

    controller.abort()
    await expect(promise).resolves.toBeUndefined()
    expect(host).toHaveBeenLastCalledWith([])
  })
})

describe('BotChallengeSolverHost', () => {
  function startSolve(url = 'https://forge.example/repo') {
    render(<BotChallengeSolverHost />)
    let promise!: ReturnType<typeof solveInWebView>
    let settled = false
    act(() => {
      promise = solveInWebView(url, new AbortController().signal)
      void promise.then(() => {
        settled = true
      })
    })
    const webView = mockWebViews.at(-1)!
    expect(webView.source).toEqual({uri: url})
    return {promise, webView, isSettled: () => settled}
  }

  function post(webView: WebViewProps, data: unknown) {
    act(() => {
      webView.onMessage({nativeEvent: {data: JSON.stringify(data)}})
    })
  }

  it('renders nothing while idle', () => {
    render(<BotChallengeSolverHost />)
    expect(mockWebViews).toHaveLength(0)
  })

  it('reports metadata from the page the WebView lands on', async () => {
    const {promise, webView} = startSolve()
    post(webView, {url: 'https://forge.example/repo', head: REAL_HEAD})
    await expect(promise).resolves.toEqual(REAL_META)
  })

  it('resolves relative images against the final URL', async () => {
    const {promise, webView} = startSolve()
    post(webView, {url: 'https://other.example/x/', head: REAL_HEAD})
    await expect(promise).resolves.toMatchObject({
      image: 'https://other.example/assets/img/logo.png',
    })
  })

  it.each([
    ['Anubis', ANUBIS_HEAD, false],
    ['Cloudflare (served as a 403)', CLOUDFLARE_HEAD, true],
  ])(
    'waits out a %s challenge page',
    async (_name, challengeHead, isHttpError) => {
      const {promise, webView, isSettled} = startSolve()
      act(() => {
        webView.onLoadStart()
        if (isHttpError) webView.onHttpError()
      })
      post(webView, {url: 'https://forge.example/repo', head: challengeHead})
      await Promise.resolve()
      expect(isSettled()).toBe(false)

      act(() => {
        webView.onLoadStart()
      })
      post(webView, {url: 'https://forge.example/repo', head: REAL_HEAD})
      await expect(promise).resolves.toEqual(REAL_META)
    },
  )

  it('gives up if the final page is an HTTP error', async () => {
    const {promise, webView} = startSolve()
    act(() => {
      webView.onLoadStart()
      webView.onHttpError()
    })
    post(webView, {url: 'https://forge.example/repo', head: REAL_HEAD})
    await expect(promise).resolves.toBeUndefined()
  })

  it.each([
    ['garbage message', 'not json'],
    ['missing head', JSON.stringify({url: 'https://forge.example/'})],
  ])('gives up on a %s', async (_name, data) => {
    const {promise, webView} = startSolve()
    act(() => {
      webView.onMessage({nativeEvent: {data}})
    })
    await expect(promise).resolves.toBeUndefined()
  })

  it('gives up on a load error', async () => {
    const {promise, webView} = startSolve()
    act(() => {
      webView.onError()
    })
    await expect(promise).resolves.toBeUndefined()
  })
})

describe('getLinkMeta with bot-challenged links', () => {
  const cardyb = (fields: {title?: string; error?: string}) =>
    fakeResponse(
      JSON.stringify({
        error: fields.error ?? '',
        url: 'https://forge.example/repo',
        title: fields.title ?? '',
        description: '',
        image: '',
      }),
    )

  /**
   * Stands in for a mounted `BotChallengeSolverHost` whose WebView gets
   * through to the real page.
   */
  function mountSolvingHost() {
    const host = jest.fn<void, [SolveRequest[]]>(requests => {
      requests.forEach(r => r.finish(REAL_META))
    })
    setSolverHost(host)
    return host
  }

  it('replaces an interstitial scraped by cardyb', async () => {
    fetchMock.mockResolvedValueOnce(
      cardyb({title: "Making sure you're not a bot!"}),
    )
    mountSolvingHost()

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.error).toBeUndefined()
    expect(meta).toMatchObject({
      url: 'https://forge.example/repo',
      ...REAL_META,
    })
  })

  it('drops the interstitial metadata if the challenge cannot be solved', async () => {
    fetchMock.mockResolvedValueOnce(
      cardyb({title: "Making sure you're not a bot!"}),
    )

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.title).toBeUndefined()
    expect(meta.description).toBeUndefined()
    expect(meta.image).toBeUndefined()
    expect(meta.error).toBeUndefined()
  })

  it('recovers from a cardyb error caused by a challenge', async () => {
    fetchMock
      .mockResolvedValueOnce(cardyb({error: 'Unable to generate link preview'}))
      .mockResolvedValueOnce(
        fakeResponse(CLOUDFLARE_HEAD, {headers: {'cf-mitigated': 'challenge'}}),
      )
    mountSolvingHost()

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.error).toBeUndefined()
    expect(meta).toMatchObject(REAL_META)
  })

  it("keeps cardyb's error if the page isn't behind a challenge", async () => {
    fetchMock
      .mockResolvedValueOnce(cardyb({error: 'Unable to generate link preview'}))
      .mockResolvedValueOnce(fakeResponse(REAL_HEAD))
    const host = mountSolvingHost()

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.error).toBe('Error: Unable to generate link preview')
    expect(meta.title).toBeUndefined()
    expect(host).toHaveBeenCalledTimes(1) // only the initial registration
  })

  it('leaves normal cardyb results alone', async () => {
    fetchMock.mockResolvedValueOnce(cardyb({title: 'Fedora Forge'}))
    const host = mountSolvingHost()

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.title).toBe('Fedora Forge')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(host).toHaveBeenCalledTimes(1) // only the initial registration
  })
})

describe('getLinkMeta on web', () => {
  /*
   * jest runs with the iOS preset, so load link-meta against the web variant
   * of botChallenge explicitly. On web the browser can't read challenged
   * pages (no CORS headers), so the only thing we can do is not post the
   * interstitial - even if a host were somehow mounted.
   */
  let getLinkMetaOnWeb!: typeof getLinkMeta
  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('#/lib/link-meta/botChallenge', () =>
        jest.requireActual('#/lib/link-meta/botChallenge/index.web'),
      )
      ;({getLinkMeta: getLinkMetaOnWeb} = jest.requireActual<
        typeof import('#/lib/link-meta/link-meta')
      >('#/lib/link-meta/link-meta'))
    })
  })

  const cardyb = (fields: {title?: string; error?: string}) =>
    fakeResponse(
      JSON.stringify({
        error: fields.error ?? '',
        url: 'https://forge.example/repo',
        title: fields.title ?? '',
        description: '',
        image: '',
      }),
    )

  it('drops an interstitial scraped by cardyb', async () => {
    fetchMock.mockResolvedValueOnce(
      cardyb({title: "Making sure you're not a bot!"}),
    )
    const host = jest.fn()
    setSolverHost(host)

    const meta = await getLinkMetaOnWeb('https://forge.example/repo')

    expect(meta.title).toBeUndefined()
    expect(meta.description).toBeUndefined()
    expect(meta.image).toBeUndefined()
    expect(meta.error).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(host).toHaveBeenCalledTimes(1) // only the initial registration
  })

  it("keeps cardyb's error without probing the page", async () => {
    fetchMock.mockResolvedValueOnce(
      cardyb({error: 'Unable to generate link preview'}),
    )

    const meta = await getLinkMetaOnWeb('https://forge.example/repo')

    expect(meta.error).toBe('Error: Unable to generate link preview')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves normal cardyb results alone', async () => {
    fetchMock.mockResolvedValueOnce(cardyb({title: 'Fedora Forge'}))

    const meta = await getLinkMetaOnWeb('https://forge.example/repo')

    expect(meta.title).toBe('Fedora Forge')
  })
})
