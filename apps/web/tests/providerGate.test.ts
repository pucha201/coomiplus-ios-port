import assert from 'node:assert/strict'
import test from 'node:test'
import { decideProviderGate } from '../src/utils/providerGate.ts'

/**
 * 「模型列表明明有，却被推进控制台强制添加模型」的根因：界面上只有
 * 「有/没有」两态。切云端那一瞬列表被清空 = 没有 → 直接把用户推去添加。
 * 这里补上第三种状态：还不知道。不知道的时候只许等，不许赶人。
 */

test('模型列表就绪时正常发送', () => {
  assert.equal(decideProviderGate({ ready: true, known: true }), 'send')
})

test('列表还没读回来时只是「不知道」，不能当成「没有模型」', () => {
  assert.equal(decideProviderGate({ ready: false, known: false }), 'reading')
})

test('已经确认这台引擎上一个模型都没有，才把用户带去添加模型', () => {
  assert.equal(decideProviderGate({ ready: false, known: true }), 'add-model')
})

test('就绪判断优先于其他两态', () => {
  assert.equal(decideProviderGate({ ready: true, known: false }), 'send')
})
