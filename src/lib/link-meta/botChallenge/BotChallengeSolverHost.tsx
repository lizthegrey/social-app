import {useEffect, useRef, useState} from 'react'
import {View} from 'react-native'
import {WebView, type WebViewMessageEvent} from 'react-native-webview'

import {
  setSolverHost,
  type SolveRequest,
} from '#/lib/link-meta/botChallenge/solver'
import {
  getPageTitle,
  isBotChallengeTitle,
  parsePageMeta,
} from '#/lib/link-meta/botChallenge/util'

/*
 * Runs after every page load in the hidden WebView and reports the page's
 * <head>. The host decides whether it's still a challenge interstitial.
 */
const REPORT_PAGE_JS = `(function () {
  window.ReactNativeWebView.postMessage(JSON.stringify({
    url: location.href,
    head: document.head ? document.head.outerHTML : '',
  }));
})();
true;`

/**
 * Mount once near the app root. Renders nothing until `getLinkMeta` needs a
 * page loaded in a real browser engine - e.g. to get past a bot challenge
 * that cardyb can't - then renders an invisible WebView per pending request.
 */
export function BotChallengeSolverHost() {
  const [requests, setRequests] = useState<SolveRequest[]>([])

  useEffect(() => {
    setSolverHost(setRequests)
    return () => setSolverHost(undefined)
  }, [])

  return requests.map(request => (
    <SolverWebView key={request.id} request={request} />
  ))
}

function SolverWebView({request}: {request: SolveRequest}) {
  const httpError = useRef(false)

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const {url, head} = JSON.parse(e.nativeEvent.data) as {
        url?: unknown
        head?: unknown
      }
      if (typeof head !== 'string') {
        request.finish(undefined)
        return
      }
      /*
       * Still on the interstitial: let the challenge's own script run and
       * navigate. Checked before the HTTP status because Cloudflare serves
       * its challenge as a 403. If it never clears (e.g. it wants a click),
       * the caller's timeout gives up.
       */
      if (isBotChallengeTitle(getPageTitle(head))) return
      if (httpError.current) {
        request.finish(undefined)
        return
      }
      const pageUrl =
        typeof url === 'string' && /^https?:/.test(url) ? url : request.url
      request.finish(parsePageMeta(head, pageUrl))
    } catch {
      request.finish(undefined)
    }
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1,
        height: 1,
        opacity: 0,
      }}>
      <WebView
        source={{uri: request.url}}
        originWhitelist={['http://*', 'https://*']}
        javaScriptEnabled
        injectedJavaScript={REPORT_PAGE_JS}
        onMessage={onMessage}
        onLoadStart={() => {
          httpError.current = false
        }}
        // don't make a card out of a 404 or a challenge's block page
        onHttpError={() => {
          httpError.current = true
        }}
        onError={() => request.finish(undefined)}
        mediaPlaybackRequiresUserAction
        allowsInlineMediaPlayback={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
      />
    </View>
  )
}
