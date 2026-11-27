/** QQ on Android already places the webview below its native top chrome. */
export function bootstrapBrowserInsets() {
  if (/Android/i.test(navigator.userAgent) && /\b(?:QQ|MQQBrowser)\/[\d.]+/i.test(navigator.userAgent)) {
    document.documentElement.dataset.browser = 'android-qq';
  }
}
