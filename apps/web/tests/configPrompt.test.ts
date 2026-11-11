import assert from 'node:assert/strict'
import test from 'node:test'
import { configPromptFor } from '../src/utils/configPrompt.ts'

/**
 * configuration_required 只该「说清楚该去哪儿」，不该自己把页面跳走：
 * 用户在写别的东西，突然被扔到模型配置页就是连环反应。
 * 引擎给出的 route 也不能直接信——事件来自对面那台电脑。
 */

test('第一次没配置：话术指向配置供应商，不说文件坏了', () => {
  const prompt = configPromptFor({ reason: 'not_configured', message: '请先配置并启用一个可用的模型供应商' })
  assert.match(prompt.text, /模型供应商/)
  assert.doesNotMatch(prompt.text, /损坏|读不出/)
  assert.equal(prompt.action?.route, '/providers')
  assert.ok(prompt.action!.label.length > 0)
})

test('配置读不出来：要说清是配置本身出问题，别让人重新填一遍', () => {
  const prompt = configPromptFor({ reason: 'invalid_config', message: '请先配置并启用一个可用的模型供应商' })
  assert.match(prompt.text, /损坏|读不出/)
  assert.match(prompt.text, /模型配置/)
})

test('认不出的 reason 退回引擎原文，仍然给出安全入口', () => {
  const prompt = configPromptFor({ message: '引擎自定义的提示' })
  assert.equal(prompt.text, '引擎自定义的提示')
  assert.equal(prompt.action?.route, '/providers')
  assert.equal(configPromptFor({}).text.length > 0, true)
})

test('只认白名单里的 route：远端引擎给别的地址就不给跳转', () => {
  assert.equal(configPromptFor({ reason: 'not_configured', route: '/side-effect' }).action, null)
  assert.equal(configPromptFor({ reason: 'not_configured', route: '//evil.com' }).action, null)
  assert.equal(configPromptFor({ reason: 'not_configured' }).action?.route, '/providers')
})
