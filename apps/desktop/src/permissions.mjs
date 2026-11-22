import { ownedURL } from './host.mjs';

/**
 * Renderer permissions granted by the desktop shell, for its own page only.
 *
 * Electron grants renderer permissions by default, so denying by default means
 * the handler also has to grant the ones the shared UI actually uses. Each name
 * below was measured in the installed Electron build, because the same user
 * action can ask for different names depending on whether a click activated it.
 * Electron can pass an empty or opaque requesting URL, so an untrusted origin
 * is a denial rather than a thrown error.
 */
const granted = new Set([
  // `navigator.clipboard.writeText`: Chromium asks for clipboard-read when the
  // page writes without user activation and for clipboard-sanitized-write when
  // a click is the activation. Granting only clipboard-read leaves the smoke
  // write passing while every copy button a user presses fails with
  // `NotAllowedError: Write permission denied`.
  'clipboard-read',
  'clipboard-sanitized-write',
  // `mediaElement.requestFullscreen`: the check handler answers
  // automatic-fullscreen and the request handler answers fullscreen. Denying
  // either leaves the fullscreen request promise unsettled, so the player's
  // fullscreen button silently does nothing instead of reporting a refusal.
  'fullscreen',
  'automatic-fullscreen',
]);

export function permissionGranted(permission, requestingUrl) {
  if (!granted.has(permission)) return false;
  try {
    return ownedURL(requestingUrl);
  } catch {
    return false;
  }
}
