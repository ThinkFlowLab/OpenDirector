import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { createMessages } from '../src/i18n.js'

test('invalid URL diagnostics retain the field and reason without storing or displaying secrets', () => {
  for (const value of [
    'https://user:private-password@example.invalid',
    'https://example.invalid/?token=private-query-token',
    'https://example.invalid/?',
    'https://example.invalid/#',
    'malformed private-invalid-token',
    'file:///private-scheme-token',
  ]) {
    assert.throws(() => resolveConfig({ baseUrl: value }), error => {
      assert.deepEqual(error.params, { field: 'baseUrl' })
      for (const locale of ['en-US', 'zh-CN']) {
        const message = createMessages(locale)(error.key, error.params)
        assert.match(message, /baseUrl/)
        assert.doesNotMatch(message, /private-|example\.invalid|\{value\}/)
      }
      return true
    })
  }
})
