import {sha256} from 'js-sha256'

import {fetchLinkMetaViaAnubis} from '#/lib/link-meta/anubis'
import {
  decodeHtmlEntities,
  isAnubisChallengeTitle,
  MAX_POW_DIFFICULTY,
  parseAnubisChallenge,
  parsePageMeta,
  parseRefresh,
  solveProofOfWork,
} from '#/lib/link-meta/anubis/util'
import {getLinkMeta} from '#/lib/link-meta/link-meta'

/*
 * jestSetup stubs out node's crypto, which js-sha256 would otherwise use.
 * Force its pure-JS implementation, which is what runs on device anyway.
 */
jest.mock('js-sha256', () => {
  ;(globalThis as {JS_SHA256_NO_NODE_JS?: boolean}).JS_SHA256_NO_NODE_JS = true
  return jest.requireActual('js-sha256')
})

const RANDOM_DATA =
  'b8d25ea90a64399742976be62156ce6afdeaf160288f2c3122f6a1b0d2b2384c'

/**
 * Trimmed from a real Anubis 1.25 interstitial.
 */
function challengePage({
  algorithm = 'fast',
  difficulty = 2,
  basePrefix = '',
}: {algorithm?: string; difficulty?: number; basePrefix?: string} = {}) {
  return `<!doctype html><html lang="en"><head>
<title>Making sure you&#39;re not a bot!</title>
<meta name="robots" content="noindex,nofollow">
<script async type="module" src="/.within.website/x/cmd/anubis/static/js/main.mjs?cacheBuster=1.25.0"></script>
</head><body>
<script id="anubis_version" type="application/json">"1.25.0"</script>
<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"${algorithm}","difficulty":${difficulty}},"challenge":{"issuedAt":"2026-09-29T04:59:48.410247435Z","metadata":{},"id":"01a0eb88-873a-73bc-a4d6-349f31d1052e","method":"${algorithm}","randomData":"${RANDOM_DATA}","policyRuleHash":"ac980f49c4d35fab","difficulty":${difficulty},"spent":false}}</script>
<script id="anubis_base_prefix" type="application/json">"${basePrefix}"</script>
</body></html>`
}

const REAL_PAGE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Fedora Forge &amp; friends">
<meta content="A self-hosted forge." name="description">
<meta property='og:image' content='/assets/img/logo.png'>
</head><body><meta property="og:title" content="not in head"></body></html>`

function fakeResponse(
  body: string,
  {
    url = '',
    headers = {},
    status = 200,
  }: {url?: string; headers?: Record<string, string>; status?: number} = {},
) {
  return {
    url,
    ok: status >= 200 && status < 300,
    headers: {get: (k: string) => headers[k.toLowerCase()] ?? null},
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  }
}

describe('isAnubisChallengeTitle', () => {
  it.each([
    ["Making sure you're not a bot!", true],
    ['Making sure you&#39;re not a bot!', true],
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

describe('parseAnubisChallenge', () => {
  it.each([
    [
      'current format',
      challengePage(),
      {
        id: '01a0eb88-873a-73bc-a4d6-349f31d1052e',
        randomData: RANDOM_DATA,
        algorithm: 'fast',
        difficulty: 2,
      },
    ],
    [
      'pre-1.20 format',
      `<script id="anubis_challenge" type="application/json">{"challenge":"abc","rules":{"algorithm":"slow","difficulty":3}}</script>`,
      {id: undefined, randomData: 'abc', algorithm: 'slow', difficulty: 3},
    ],
    ['not a challenge', REAL_PAGE, undefined],
    [
      'malformed json',
      `<script id="anubis_challenge" type="application/json">{nope</script>`,
      undefined,
    ],
  ])('%s', (_name, html, expected) => {
    expect(parseAnubisChallenge(html)).toEqual(expected)
  })
})

describe('solveProofOfWork', () => {
  it.each([1, 2, 3])('finds a valid nonce at difficulty %i', async d => {
    const {nonce, hash} = await solveProofOfWork(RANDOM_DATA, d)
    expect(hash).toBe(sha256(RANDOM_DATA + nonce))
    expect(hash.startsWith('0'.repeat(d))).toBe(true)
  })

  it('refuses excessive difficulty', async () => {
    await expect(
      solveProofOfWork(RANDOM_DATA, MAX_POW_DIFFICULTY + 1),
    ).rejects.toThrow('too high')
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      solveProofOfWork(RANDOM_DATA, MAX_POW_DIFFICULTY, controller.signal),
    ).rejects.toThrow('Aborted')
  })
})

describe('parseRefresh', () => {
  it.each([
    ['5; url=/foo?a=1', {delaySeconds: 5, url: '/foo?a=1'}],
    [
      "3;URL='https://x.test/a&amp;b'",
      {delaySeconds: 3, url: 'https://x.test/a&b'},
    ],
    ['5', undefined],
    [null, undefined],
  ])('%p', (value, expected) => {
    expect(parseRefresh(value)).toEqual(expected)
  })
})

describe('parsePageMeta', () => {
  it.each([
    [
      'og tags, relative image, attribute order',
      REAL_PAGE,
      {
        title: 'Fedora Forge & friends',
        description: 'A self-hosted forge.',
        image: 'https://forge.example/assets/img/logo.png',
      },
    ],
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
      'empty page',
      '',
      {title: undefined, description: undefined, image: undefined},
    ],
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

describe('fetchLinkMetaViaAnubis', () => {
  const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit?]>()
  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('solves a proof-of-work challenge and parses the real page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse(challengePage({basePrefix: '/sub/'}), {
          url: 'https://forge.example/repo?tab=1',
        }),
      )
      .mockResolvedValueOnce(fakeResponse(REAL_PAGE))

    const meta = await fetchLinkMetaViaAnubis(
      'https://forge.example/repo?tab=1',
      new AbortController().signal,
    )

    expect(meta).toEqual({
      title: 'Fedora Forge & friends',
      description: 'A self-hosted forge.',
      image: 'https://forge.example/assets/img/logo.png',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({credentials: 'include'})

    const pass = new URL(fetchMock.mock.calls[1][0])
    expect(pass.origin + pass.pathname).toBe(
      'https://forge.example/sub/.within.website/x/cmd/anubis/api/pass-challenge',
    )
    const params = Object.fromEntries(pass.searchParams)
    expect(params).toMatchObject({
      id: '01a0eb88-873a-73bc-a4d6-349f31d1052e',
      redir: '/repo?tab=1',
    })
    expect(params.response).toBe(sha256(RANDOM_DATA + params.nonce))
    expect(params.response.startsWith('00')).toBe(true)
    expect(Number(params.elapsedTime)).toBeGreaterThanOrEqual(0)
  })

  it('follows a metarefresh challenge after the delay', async () => {
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse(challengePage({algorithm: 'metarefresh'}), {
          url: 'https://forge.example/repo',
          headers: {refresh: '0; url=/.within.website/pass?id=1'},
        }),
      )
      .mockResolvedValueOnce(fakeResponse(REAL_PAGE))

    const meta = await fetchLinkMetaViaAnubis(
      'https://forge.example/repo',
      new AbortController().signal,
    )

    expect(meta?.title).toBe('Fedora Forge & friends')
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://forge.example/.within.website/pass?id=1',
    )
  })

  it.each([
    ['unsupported challenge type', challengePage({algorithm: 'preact'}), 1],
    ['difficulty too high', challengePage({difficulty: 9}), 1],
  ])('gives up on %s', async (_name, page, calls) => {
    fetchMock.mockResolvedValueOnce(fakeResponse(page))
    await expect(
      fetchLinkMetaViaAnubis(
        'https://forge.example/',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })

  it('gives up if the real page is an error', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(challengePage()))
      .mockResolvedValueOnce(fakeResponse(REAL_PAGE, {status: 404}))
    await expect(
      fetchLinkMetaViaAnubis(
        'https://forge.example/',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  it('gives up if still challenged after passing', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(challengePage()))
      .mockResolvedValueOnce(fakeResponse(challengePage()))
    await expect(
      fetchLinkMetaViaAnubis(
        'https://forge.example/',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  it('uses the page directly when not challenged', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(REAL_PAGE))
    const meta = await fetchLinkMetaViaAnubis(
      'https://forge.example/repo',
      new AbortController().signal,
    )
    expect(meta?.title).toBe('Fedora Forge & friends')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('getLinkMeta with an Anubis-blocked cardyb result', () => {
  const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit?]>()
  const cardybChallenge = JSON.stringify({
    error: '',
    url: 'https://forge.example/repo',
    title: "Making sure you're not a bot!",
    description: '',
    image: '',
  })
  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('replaces the interstitial with on-device metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(cardybChallenge))
      .mockResolvedValueOnce(
        fakeResponse(challengePage(), {url: 'https://forge.example/repo'}),
      )
      .mockResolvedValueOnce(fakeResponse(REAL_PAGE))

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta).toMatchObject({
      url: 'https://forge.example/repo',
      title: 'Fedora Forge & friends',
      description: 'A self-hosted forge.',
      image: 'https://forge.example/assets/img/logo.png',
    })
    expect(meta.error).toBeUndefined()
  })

  it('drops the interstitial metadata if the challenge cannot be solved', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(cardybChallenge))
      .mockRejectedValueOnce(new Error('network down'))

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.title).toBeUndefined()
    expect(meta.description).toBeUndefined()
    expect(meta.image).toBeUndefined()
    expect(meta.error).toBeUndefined()
  })

  it('leaves normal cardyb results alone', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(
        JSON.stringify({
          error: '',
          url: 'https://forge.example/repo',
          title: 'Fedora Forge',
          description: 'desc',
          image: 'https://cardyb.bsky.app/v1/image?url=x',
        }),
      ),
    )

    const meta = await getLinkMeta('https://forge.example/repo')

    expect(meta.title).toBe('Fedora Forge')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
