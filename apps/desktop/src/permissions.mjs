import { ownedURL } from './host.mjs';

/**
 * Renderer permissions granted by the desktop shell, for its own page only.
 *
 * Electron grants renderer permissions by default, so denying by default means
 * the handler also has to grant the ones the shared UI actually uses. Each name
 * below belongs to a call the renderer makes; a permission without a caller is
 * a capability, not a fix. Electron can pass an empty or opaque requesting URL,
 * so an untrusted origin is a denial rather than a thrown error.
 */
const granted = new Set([
  // `navigator.clipboard.writeText` from a click: Chromium asks for
  // clipboard-sanitized-write only when the write is sanitized and a click is
  // the activation, and for the read/write pair otherwise. The renderer copies
  // from click handlers only, so the read/write name stays denied: it also
  // grants `navigator.clipboard.readText`, and this application never reads the
  // system clipboard. Granting it would be a policy change for a future
  // activation-free copy, not a repair for a broken copy button.
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
