import assert from 'node:assert/strict'
import test from 'node:test'
import { attributeTransport, readTransportDiag } from '../src/utils/transportAttribution.ts'

/**
 * 「互联连不上」最难的地方是用户不知道卡在哪条通道上。
 * 桥层每条通道（WebRTC 直连 / 加密中转 / 局域网直连）都会报自己的阶段和原因，
 * 这里负责把它翻成一句能照着做的话——英文原因直接甩出去等于没说。
 */

test('本机模式没有云端通道诊断时不编造任何通道状态', () => {
  assert.equal(attributeTransport(null), null)
  assert.equal(attributeTransport(undefined), null)
  assert.equal(readTransportDiag(), null)
})

test('直连握手中只报「正在尝试哪条通道」，不算失败', () => {
  assert.deepEqual(attributeTransport({ phase: 'webrtc', state: 'connecting', reason: '' }), {
    channel: 'WebRTC 直连',
    detail: '正在尝试 WebRTC 直连',
    connected: false,
  })
})

test('切到加密中转时把上一条通道为什么放弃一起说清', () => {
  assert.deepEqual(attributeTransport({ phase: 'relay', state: 'connecting', reason: '直连不可用' }), {
    channel: '加密中转',
    detail: '正在尝试加密中转：直连不可用',
    connected: false,
  })
})

test('三条通道的名字分别是直连、中转、局域网', () => {
  assert.equal(attributeTransport({ phase: 'lan', state: 'error', reason: '' })?.channel, '局域网直连')
  assert.equal(attributeTransport({ phase: 'webrtc', state: 'open', reason: '' })?.channel, 'WebRTC 直连')
})

test('连上的那条通道报「已连上」，不再报重连次数', () => {
  assert.deepEqual(attributeTransport({ phase: 'relay', state: 'open', reason: '加密中转' }), {
    channel: '加密中转',
    detail: '已通过加密中转连上',
    connected: true,
  })
})

test('配对凭据失效说成人话并给出下一步，而不是 401', () => {
  const line = attributeTransport({ phase: 'lan', state: 'error', reason: 'HTTP 401 unauthorized' })!

  assert.match(line.detail, /配对凭据已失效/)
  assert.match(line.detail, /重新生成配对码/)
  assert.doesNotMatch(line.detail, /401/)
})

test('信令、打洞、超时的英文原因各归各的说法', () => {
  assert.match(attributeTransport({ phase: 'webrtc', state: 'error', reason: 'P2P signaling failed' })!.detail, /信令服务器不可用/)
  assert.match(attributeTransport({ phase: 'webrtc', state: 'error', reason: 'no ICE candidates' })!.detail, /NAT 打洞/)
  assert.match(attributeTransport({ phase: 'webrtc', state: 'error', reason: 'P2P connection timed out' })!.detail, /握手超时/)
})

test('中转自己的几种失败各有各的说法，不许都写成超时', () => {
  assert.match(attributeTransport({ phase: 'relay', state: 'reconnecting', reason: 'relay broker disconnected' })!.detail, /加密中转服务连不上/)
  assert.match(attributeTransport({ phase: 'relay', state: 'error', reason: 'relay connect failed' })!.detail, /加密中转服务连不上/)
  assert.match(attributeTransport({ phase: 'webrtc', state: 'error', reason: 'DataChannel error' })!.detail, /加密数据通道/)
})

test('MQTT broker 的 WebSocket 失败翻成人话，不把英文原样甩给用户', () => {
  const line = attributeTransport({ phase: 'webrtc', state: 'connecting', reason: 'MQTT broker WebSocket failed' })!

  assert.match(line.detail, /加密中转服务连不上/)
  assert.doesNotMatch(line.detail, /MQTT|WebSocket/)
})

test('broker 通了但对端不在：报「电脑端没有应答」，不说中转服务坏了', () => {
  for (const reason of ['relay peer absent', 'relay peer heartbeat lost', 'relay peer not reachable']) {
    const line = attributeTransport({ phase: 'relay', state: 'connecting', reason })!
    assert.match(line.detail, /电脑端没有应答/)
    assert.match(line.detail, /电脑在运行/)
    assert.doesNotMatch(line.detail, /中转服务连不上/)
  }
})

test('「中转不可用：直连超时」只报最外面那层失败', () => {
  const detail = attributeTransport({ phase: 'lan', state: 'connecting', reason: 'relay unavailable: P2P connection timed out' })!.detail

  assert.match(detail, /加密中转不可用/)
  assert.doesNotMatch(detail, /握手超时/)
})

test('局域网端口没人应答时提示检查电脑是否在跑', () => {
  assert.match(attributeTransport({ phase: 'lan', state: 'error', reason: 'Failed to fetch' })!.detail, /电脑的端口没有应答/)
})

test('局域网探活成功时说的是「谁先应答」，不是又一条超时', () => {
  const line = attributeTransport({ phase: 'lan', state: 'connecting', reason: 'paired device is reachable on the local network' })!

  assert.equal(line.channel, '局域网直连')
  assert.match(line.detail, /局域网里的电脑有应答/)
  assert.doesNotMatch(line.detail, /reachable/)
})

test('认不出的原因原样带出，绝不编造', () => {
  assert.deepEqual(attributeTransport({ phase: 'relay', state: 'closed', reason: '对端把会话关了' }), {
    channel: '加密中转',
    detail: '加密中转已断开：对端把会话关了',
    connected: false,
  })
})

test('重连中说明通道断过、正在恢复', () => {
  assert.match(
    attributeTransport({ phase: 'webrtc', state: 'reconnecting', reason: 'P2P connection lost' })!.detail,
    /^WebRTC 直连中断，正在恢复：/,
  )
})
