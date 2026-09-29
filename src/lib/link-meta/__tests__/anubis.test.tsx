import {act, render} from '@testing-library/react-native'

import {AnubisSolverHost} from '#/lib/link-meta/anubis'
import {
  setSolverHost,
  solveInWebView,
  type SolveRequest,
} from '#/lib/link-meta/anubis/solver'
import {
  decodeHtmlEntities,
  isAnubisChallengeTitle,
  parsePageMeta,
} from '#/lib/link-meta/anubis/util'
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

function fakeResponse(body: string) {
  return {
    ok: true,
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  }
}

afterEach(() => {
  setSolverHost(undefined)
  mockWebViews.length = 0
})

describe('isAnubisChallengeTitle', () => {
  it.each([
    ["Making sure you're not a bot!", true],
    ['Making sure you&#39;re not a bot!', true],
    // as stored in a real post's embed record
    ['Making sure you&apos;re not a bot!', true],
    ['Making sure you’re not a bot!', true],
    ['  Dein Browser wird geprüft!  ', true],
    ['正在确认你是不是机器人！', true],
    ['GNOME / gtk · GitLab', false],
    ['', false],
    [undefined, false],
  ])('%p -> %p', (title, expected) => {
    expect(isAnubisChallengeTitle(title)).toBe(expected)
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
    [
      'an Anubis interstitial is not metadata',
      `<head><title>Making sure you&#39;re not a bot!</title></head>`,
      undefined,
    ],
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

describe('AnubisSolverHost', () => {
  function startSolve(url = 'https://forge.example/repo') {
    render(<AnubisSolverHost />)
    let promise!: ReturnType<typeof solveInWebView>
    act(() => {
      promise = solveInWebView(url, new AbortController().signal)
    })
    const webView = mockWebViews.at(-1)!
    expect(webView.source).toEqual({uri: url})
    return {promise, webView}
  }

  function post(webView: WebViewProps, data: unknown) {
    act(() => {
      webView.onMessage({nativeEvent: {data: JSON.stringify(data)}})
    })
  }

  it('renders nothing while idle', () => {
    render(<AnubisSolverHost />)
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

  it('ignores an error status on the challenge page but not the final page', async () => {
    const {promise, webView} = startSolve()
    act(() => {
      webView.onLoadStart()
      webView.onHttpError()
      webView.onLoadStart()
    })
    post(webView, {url: 'https://forge.example/repo', head: REAL_HEAD})
    await expect(promise).resolves.toEqual(REAL_META)

    const second = startSolve()
    act(() => {
      second.webView.onLoadStart()
      second.webView.onHttpError()
    })
    post(second.webView, {url: 'https://forge.example/repo', head: REAL_HEAD})
    await expect(second.promise).resolves.toBeUndefined()
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

describe('getLinkMeta with an Anubis-blocked cardyb result', () => {
  const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit?]>()
  const cardyb = (title: string) =>
    fakeResponse(
      JSON.stringify({
        error: '',
        url: 'https://forge.example/repo',
        title,
        description: '',
        image: '',
      }),
    )

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('replaces the interstitial with metadata from the WebView', async () => {
    fetchMock.mockResolvedValueOnce(cardyb("Making sure you're not a bot!"))
    setSolverHost(requests => {
      requests.forEach(r => r.finish(REAL_META))
    })

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta).toMatchObject({
      url: 'https://forge.example/repo',
      ...REAL_META,
    })
    expect(meta.error).toBeUndefined()
  })

  it('drops the interstitial metadata if the challenge cannot be solved', async () => {
    fetchMock.mockResolvedValueOnce(cardyb("Making sure you're not a bot!"))

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.title).toBeUndefined()
    expect(meta.description).toBeUndefined()
    expect(meta.image).toBeUndefined()
    expect(meta.error).toBeUndefined()
  })

  it('leaves normal cardyb results alone', async () => {
    fetchMock.mockResolvedValueOnce(cardyb('Fedora Forge'))
    const host = jest.fn()
    setSolverHost(host)

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.title).toBe('Fedora Forge')
    expect(host).toHaveBeenCalledTimes(1) // only the initial registration
  })
})
