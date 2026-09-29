import {sha256} from 'js-sha256'

/**
 * Titles of the Anubis (https://anubis.techaro.lol) interstitial page in
 * every locale it ships. If cardyb hands us one of these as a page title, it
 * got the proof-of-work page instead of the real content.
 */
const ANUBIS_CHALLENGE_TITLES = new Set(
  [
    'Bekrefter at du ikke er en bot!',
    'Bot olmadığınızdan emin oluyoruz!',
    'Certificando de que você não é um bot!',
    'Controllo se sei un robot...',
    'Dein Browser wird geprüft!',
    'Even checken of je een bot bent!',
    'Geng úr skugga um að þú sért ekki botti!',
    "Je m'assure que vous n'êtes pas un robot !",
    'Kollar så att du inte är en bot!',
    'Kontrollime, et sa ei ole bott!',
    "Making sure you're not a bot!",
    'Provjeravamo da niste bot!',
    'Robota ez zarela ziurtatzen!',
    'Sinisigurado na hindi ka isang bot!',
    'Sprawdzamy, czy nie jesteś botem!',
    'Stadfester at du ikkje er bot!',
    'Stengiamasi užtikrinti, jog jūs nesate robotas!',
    'Ujišťujeme se, že nejste robot!',
    'Varmistetaan ettet ole robotti!',
    '¡Asegurándonos de que no eres un robot!',
    'Đảm bảo bạn không phải là bot!',
    'Перевірка, чи ви не бот!',
    'Проверяем, что вы не бот!',
    'Уверяваме се, че не си бот!',
    'ตรวจสอบให้แน่ใจว่าคุณไม่ใช่บอท!',
    'あなたがボットでないことを確認しています！',
    '正在确认你是不是机器人！',
    '正在確認你是不是機器人！',
  ].map(normalizeTitle),
)

function normalizeTitle(title: string): string {
  return decodeHtmlEntities(title).replace(/[‘’]/g, "'").trim()
}

/**
 * Whether a title scraped by cardyb is actually the Anubis interstitial.
 */
export function isAnubisChallengeTitle(title: string | undefined): boolean {
  if (!title) return false
  return ANUBIS_CHALLENGE_TITLES.has(normalizeTitle(title))
}

export type AnubisChallenge = {
  /**
   * Challenge ID, absent on Anubis versions older than 1.20.
   */
  id?: string
  randomData: string
  algorithm: string
  difficulty: number
}

/**
 * Extracts the challenge from an Anubis interstitial page, or returns
 * undefined if the page isn't one.
 */
export function parseAnubisChallenge(
  html: string,
): AnubisChallenge | undefined {
  const match = html.match(
    /<script[^>]*\bid=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/i,
  )
  if (!match) return
  try {
    const parsed = JSON.parse(match[1]) as {
      rules?: {algorithm?: string; difficulty?: number}
      challenge?:
        string | {id?: string; randomData?: string; difficulty?: number}
    }
    const rules = parsed.rules ?? {}
    const challenge = parsed.challenge
    const randomData =
      typeof challenge === 'string' ? challenge : challenge?.randomData
    const difficulty =
      rules.difficulty ??
      (typeof challenge === 'object' ? challenge.difficulty : undefined)
    if (!randomData || typeof difficulty !== 'number') return
    return {
      id: typeof challenge === 'object' ? challenge.id : undefined,
      randomData,
      algorithm: rules.algorithm ?? 'fast',
      difficulty,
    }
  } catch {
    return
  }
}

/**
 * Difficulty is measured in leading hex zeroes, so expected work is 16^n
 * hashes. Past this we'd be burning the user's battery for seconds or minutes,
 * so we give up and fall back to whatever cardyb gave us.
 */
export const MAX_POW_DIFFICULTY = 5

/**
 * Hashes to try between yields to the event loop, so the UI stays responsive
 * while we grind.
 */
const HASHES_PER_YIELD = 2000

/**
 * Solves the Anubis proof-of-work: find the smallest nonce such that
 * sha256(randomData + nonce) has `difficulty` leading hex zeroes. This is the
 * same work the Anubis page would make the user's browser do.
 */
export async function solveProofOfWork(
  randomData: string,
  difficulty: number,
  signal?: AbortSignal,
): Promise<{nonce: number; hash: string}> {
  if (difficulty > MAX_POW_DIFFICULTY) {
    throw new Error(`Anubis difficulty ${difficulty} too high`)
  }
  const prefix = '0'.repeat(difficulty)
  for (let nonce = 0; ; nonce++) {
    const hash = sha256(randomData + nonce)
    if (hash.startsWith(prefix)) {
      return {nonce, hash}
    }
    if (nonce % HASHES_PER_YIELD === HASHES_PER_YIELD - 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (signal?.aborted) {
        throw new Error('Aborted solving Anubis challenge')
      }
    }
  }
}

/**
 * Parses a `Refresh` header or `<meta http-equiv="refresh">` value like
 * `5; url=/foo`.
 */
export function parseRefresh(
  value: string | null | undefined,
): {delaySeconds: number; url: string} | undefined {
  if (!value) return
  const match = decodeHtmlEntities(value).match(
    /^\s*(\d+)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)['"]?\s*$/i,
  )
  if (!match) return
  return {delaySeconds: Number(match[1]), url: match[2]}
}

export function findMetaRefresh(html: string): string | undefined {
  for (const attrs of iterateMetaTags(html)) {
    if (attrs['http-equiv']?.toLowerCase() === 'refresh') {
      return attrs.content
    }
  }
}

export type ParsedPageMeta = {
  title?: string
  description?: string
  image?: string
}

/**
 * Pulls OpenGraph / Twitter card / plain HTML metadata out of a page, roughly
 * matching what cardyb extracts server-side.
 */
export function parsePageMeta(html: string, pageUrl: string): ParsedPageMeta {
  const headEnd = html.search(/<\/head>/i)
  const head = headEnd === -1 ? html : html.slice(0, headEnd)

  const tags: Record<string, string> = {}
  for (const attrs of iterateMetaTags(head)) {
    const key = (attrs.property ?? attrs.name)?.toLowerCase()
    if (key && attrs.content !== undefined && !(key in tags)) {
      tags[key] = attrs.content.trim()
    }
  }

  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const title =
    tags['og:title'] ||
    tags['twitter:title'] ||
    (titleTag ? decodeHtmlEntities(titleTag).trim() : undefined)
  const description =
    tags['og:description'] ||
    tags['twitter:description'] ||
    tags.description ||
    undefined
  const rawImage =
    tags['og:image:secure_url'] ||
    tags['og:image:url'] ||
    tags['og:image'] ||
    tags['twitter:image'] ||
    tags['twitter:image:src']

  let image: string | undefined
  if (rawImage) {
    try {
      image = new URL(rawImage, pageUrl).toString()
    } catch {}
  }

  return {title: title || undefined, description, image}
}

function* iterateMetaTags(html: string): Generator<Record<string, string>> {
  const metaRe = /<meta\b([^>]*)>/gi
  let m
  while ((m = metaRe.exec(html))) {
    yield parseAttributes(m[1])
  }
}

function parseAttributes(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m
  while ((m = attrRe.exec(s))) {
    const name = m[1].toLowerCase()
    if (!(name in attrs)) {
      attrs[name] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '')
    }
  }
  return attrs
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      try {
        return String.fromCodePoint(code)
      } catch {
        return entity
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}
