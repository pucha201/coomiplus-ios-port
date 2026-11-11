import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PLAN_MODE_PREFIX,
  isPlanModeTitle,
  stripPlanModePrefix,
} from '../src/utils/planPrefix.ts'

test('strips the exact legacy plan-mode prefix', () => {
  assert.equal(
    stripPlanModePrefix(`${PLAN_MODE_PREFIX}\n\n查一下这个报错`),
    '查一下这个报错',
  )
})

test('keeps ordinary user text untouched', () => {
  assert.equal(stripPlanModePrefix('查一下这个报错'), '查一下这个报错')
  assert.equal(stripPlanModePrefix(''), '')
})

test('detects titles truncated by the old derive_title', () => {
  assert.equal(isPlanModeTitle('Work in planning mode. Inspect the project…'), true)
  assert.equal(isPlanModeTitle('正常会话标题'), false)
})
