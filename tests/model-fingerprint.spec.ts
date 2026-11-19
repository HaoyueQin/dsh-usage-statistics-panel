/**
 * The merged model view's fingerprint function. The panel keeps the raw
 * `provider/model` rows intact everywhere else, so the folding rules pinned
 * here are the ONLY place a cross-provider identity is assumed — keep them
 * narrow and keep the related cases covered.
 */
import { describe, expect, it } from 'vitest'
import { modelFingerprintOf } from '../src/client/format.ts'

describe('modelFingerprintOf', () => {
  it('drops the provider prefix', () => {
    expect(modelFingerprintOf('deepseek-official/deepseek-flash')).toBe('deepseek-flash')
    expect(modelFingerprintOf('qodercn/qmodel_38max')).toBe('qmodel_38max')
  })

  it('keeps a bare model name unchanged', () => {
    expect(modelFingerprintOf('deepseek-flash')).toBe('deepseek-flash')
    expect(modelFingerprintOf('(unknown)')).toBe('(unknown)')
  })

  it('folds provider edition and build-stamp suffixes', () => {
    expect(modelFingerprintOf('our-free-model/deepseek-v4.1-flash-free')).toBe('deepseek-flash')
    expect(modelFingerprintOf('dsh-api-dsh/deepseek-v4.1-flash-1017')).toBe('deepseek-flash')
    expect(modelFingerprintOf('vendor/model-20261017')).toBe('model')
  })

  it('folds the DeepSeek generation segment onto the tier name', () => {
    expect(modelFingerprintOf('dsh-api-free/deepseek-v4.1-flash')).toBe('deepseek-flash')
    expect(modelFingerprintOf('dsh-api-dsh/deepseek-v4.1-flash')).toBe('deepseek-flash')
    expect(modelFingerprintOf('vendor/deepseek-v5.2-chat')).toBe('deepseek-chat')
  })

  it('leaves unrelated models alone', () => {
    expect(modelFingerprintOf('uuapi/gpt-6-sol')).toBe('gpt-6-sol')
    expect(modelFingerprintOf('uu-api/gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(modelFingerprintOf('our-free-model/z-ai/glm-5.3')).toBe('z-ai/glm-5.3')
    expect(modelFingerprintOf('onetime-day/kimi-k3.1-pro')).toBe('kimi-k3.1-pro')
    expect(modelFingerprintOf('qodercn/auto')).toBe('auto')
  })

  it('is idempotent', () => {
    const once = modelFingerprintOf('dsh-api-free/deepseek-v4.1-flash-free')
    expect(modelFingerprintOf(once)).toBe(once)
  })
})