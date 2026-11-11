import assert from 'node:assert/strict'
import test from 'node:test'
import { modelOwnerNote } from '../src/utils/modelOwner.ts'

/**
 * 云端模式在手机上改模型，改的其实是电脑里那个引擎的配置。
 * 不说清这一点，用户会以为手机也有一份模型配置，回头在手机上找不到自己改的东西。
 */

test('本机模式没什么好提醒的，别在标题下面插一条无关的话', () => {
  assert.equal(modelOwnerNote({ mode: 'local', hasDevice: false }), null)
  assert.equal(modelOwnerNote({ mode: 'local', hasDevice: true, deviceName: '台式机' }), null)
})

test('云端模式要点名是哪台电脑，并且说清改动落在电脑那边', () => {
  const note = modelOwnerNote({ mode: 'cloud', hasDevice: true, deviceName: '工作室台式机' }) ?? ''
  assert.match(note, /工作室台式机/)
  assert.match(note, /电脑的引擎/)
})

test('没有设备名也要说话，不能出现「正在编辑「」的模型」', () => {
  const note = modelOwnerNote({ mode: 'cloud', hasDevice: true, deviceName: '   ' }) ?? ''
  assert.match(note, /这台电脑/)
  assert.doesNotMatch(note, /「\s*」/)
})

test('云端但还没选电脑：先让人选，别让他改一份不知道落在哪的配置', () => {
  const note = modelOwnerNote({ mode: 'cloud', hasDevice: false }) ?? ''
  assert.match(note, /还没选中电脑/)
  assert.match(note, /先选一台/)
})
