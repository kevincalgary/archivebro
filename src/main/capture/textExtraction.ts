import type { WebContents } from 'electron';

// Host-initiated extraction only -- this script runs *in* the page's own
// world via executeJavaScript, but nothing is injected the other
// direction (no contextBridge, no preload) so the page never gains any
// capability from this. It explicitly excludes form input values (not
// just password fields) so nothing a user typed but didn't submit ends up
// in the searchable archive text.
const EXTRACTION_SCRIPT = `
(function () {
  try {
    var clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return '';
    var inputs = clone.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].setAttribute('value', '');
      inputs[i].removeAttribute('value');
      if (inputs[i].tagName === 'TEXTAREA') inputs[i].textContent = '';
    }
    var scripts = clone.querySelectorAll('script, style, noscript');
    for (var j = 0; j < scripts.length; j++) scripts[j].remove();
    var text = clone.innerText || clone.textContent || '';
    return text.slice(0, 5_000_000);
  } catch (e) {
    return '';
  }
})()
`;

export async function extractVisibleText(webContents: WebContents): Promise<string> {
  const result = await webContents.executeJavaScript(EXTRACTION_SCRIPT, true);
  return typeof result === 'string' ? result : '';
}
