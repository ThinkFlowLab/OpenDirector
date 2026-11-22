import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionGranted } from '../src/permissions.mjs';

const app = 'opendirector://app/';
const allowed = ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'automatic-fullscreen'];

test('The application page receives the permissions its controls use', () => {
  for (const permission of allowed) {
    assert.equal(permissionGranted(permission, app), true, permission);
    assert.equal(permissionGranted(permission, 'opendirector://app/canvas?x=1'), true, permission);
  }
});

test('A clipboard write needs both names because the activation changes the request', () => {
  // Measured in Electron 45: a scripted write asks for clipboard-read, the same
  // write from a click asks for clipboard-sanitized-write. Granting one name
  // leaves the other path failing with NotAllowedError.
  assert.equal(permissionGranted('clipboard-read', app), true);
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
    'opendirector://app:8080/', '', undefined, null, 'null', 'not a url']) {
    for (const permission of allowed) {
      assert.equal(permissionGranted(permission, origin), false, `${permission} on ${String(origin)}`);
    }
  }
});
