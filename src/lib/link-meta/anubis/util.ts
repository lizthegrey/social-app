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

export type ParsedPageMeta = {
  title?: string
  description?: string
  image?: string
}

/**
 * Pulls OpenGraph / Twitter card / plain HTML metadata out of a page, roughly
 * matching what cardyb extracts server-side. Returns undefined if the page has
 * none, or is itself an Anubis interstitial.
 */
export function parsePageMeta(
  html: string,
  pageUrl: string,
): ParsedPageMeta | undefined {
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
    (titleTag ? decodeHtmlEntities(titleTag).trim() : undefined) ||
    undefined
  const description =
    tags['og:description'] ||
    tags['twitter:description'] ||
    tags.description ||
    undefined
  const image = toHttpUrl(
    tags['og:image:secure_url'] ||
      tags['og:image:url'] ||
      tags['og:image'] ||
      tags['twitter:image'] ||
      tags['twitter:image:src'],
    pageUrl,
  )

  if (isAnubisChallengeTitle(title)) return
  if (!title && !description && !image) return
  return {title, description, image}
}

/**
 * The composer downloads the thumbnail on-device rather than via cardyb's
 * image proxy, so only allow http(s) - never e.g. `file:` URLs from a hostile
 * page.
 */
function toHttpUrl(url: string | undefined, base: string): string | undefined {
  if (!url) return
  try {
    const u = new URL(url, base)
    return u.protocol === 'https:' || u.protocol === 'http:'
      ? u.toString()
      : undefined
  } catch {
    return
  }
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
