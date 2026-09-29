import {useEffect, useRef, useState} from 'react'
import {View} from 'react-native'
import {WebView, type WebViewMessageEvent} from 'react-native-webview'

import {setSolverHost, type SolveRequest} from '#/lib/link-meta/anubis/solver'
import {parsePageMeta} from '#/lib/link-meta/anubis/util'

/*
 * Runs after every page load in the hidden WebView. While Anubis's challenge
 * page is up we stay quiet and let its own script solve and redirect; once
 * we land on the real page we report its <head>.
 */
const REPORT_PAGE_JS = `(function () {
  if (document.getElementById('anubis_challenge')) return;
  window.ReactNativeWebView.postMessage(JSON.stringify({
    url: location.href,
    head: document.head ? document.head.outerHTML : '',
  }));
})();
true;`

/**
 * Mount once near the app root. Renders nothing until `getLinkMeta` needs a
 * page loaded past an Anubis challenge, then renders an invisible WebView per
 * pending request.
 */
export function AnubisSolverHost() {
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
      if (httpError.current || typeof head !== 'string') {
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
        // don't make a card out of a 404 or an Anubis error page
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
