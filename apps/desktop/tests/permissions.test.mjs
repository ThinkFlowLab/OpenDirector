import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionGranted } from '../src/permissions.mjs';

const app = 'opendirector://app/';
const allowed = ['clipboard-sanitized-write', 'fullscreen', 'automatic-fullscreen'];

test('The application page receives the permissions its controls use', () => {
  for (const permission of allowed) {
    assert.equal(permissionGranted(permission, app), true, permission);
    assert.equal(permissionGranted(permission, 'opendirector://app/canvas?x=1'), true, permission);
    // The check handler answers a serialized origin, which carries no path.
    assert.equal(permissionGranted(permission, 'opendirector://app'), true, permission);
  }
});

test('A clipboard write without user activation stays denied', () => {
  // Chromium reports the read/write clipboard permission as clipboard-read, so
  // granting it to satisfy a scripted write would also grant
  // `navigator.clipboard.readText`. Every copy in the shared UI starts from a
  // click and asks for clipboard-sanitized-write instead, so the shell keeps this
  // name denied and the installed smoke asserts the denial.
  assert.equal(permissionGranted('clipboard-read', app), false);
  assert.equal(permissionGranted('clipboard-read', 'opendirector://app/canvas'), false);
  assert.equal(permissionGranted('clipboard-sanitized-write', app), true);
});

test('Other renderer permissions stay denied', () => {
  for (const permission of ['media', 'display-capture', 'geolocation', 'notifications',
    'midi', 'pointerLock', 'openExternal', 'fileSystem', 'serial', 'usb', 'unknown', '']) {
    assert.equal(permissionGranted(permission, app), false, permission);
  }
});

test('The granted permissions do not extend to other origins', () => {
  for (const origin of ['https://example.com/', 'file:///C:/tmp/a.html', 'opendirector://other/',
    'opendirector://app:8080/', 'opendirector://app@evil.com/', 'opendirector://x.app/',
    '', undefined, null, 'null', 'not a url']) {
    for (const permission of allowed) {
      assert.equal(permissionGranted(permission, origin), false, `${permission} on ${String(origin)}`);
    }
  }
});
