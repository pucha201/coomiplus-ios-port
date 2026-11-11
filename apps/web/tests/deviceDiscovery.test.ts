import assert from 'node:assert/strict'
import test from 'node:test'
import { matchDiscoveredEndpoint, parseDiscoveredPeers } from '../src/utils/deviceDiscovery.ts'

test('发现回包按 deviceId 去重并丢掉非法条目', () => {
  const peers = parseDiscoveredPeers([
    { deviceId: 'dev_1', name: '书房电脑', host: '192.168.3.163', port: 49217, version: '1.0.0-rc68' },
    { deviceId: 'dev_1', name: '书房电脑', host: '192.168.3.164', port: 49217, version: '1.0.0-rc68' },
    { deviceId: '', host: '192.168.3.5', port: 1 },
    { deviceId: 'dev_2', host: '', port: 1 },
    { deviceId: 'dev_3', host: '192.168.3.5', port: 0 },
    { deviceId: 'dev_4', host: '192.168.3.5', port: 70000 },
    { deviceId: 'dev_5', host: '192.168.3.5', port: '1234' },
    null,
    'nope',
  ])
  assert.deepEqual(peers, [
    { deviceId: 'dev_1', name: '书房电脑', host: '192.168.3.163', port: 49217, version: '1.0.0-rc68' },
  ])
})

test('不是数组 / 缺字段时返回空列表', () => {
  assert.deepEqual(parseDiscoveredPeers(undefined), [])
  assert.deepEqual(parseDiscoveredPeers({ peers: [] }), [])
})

test('按 deviceId 拼出电脑当前地址，IPv6 自动加方括号', () => {
  const peers = parseDiscoveredPeers([
    { deviceId: 'dev_1', name: 'PC', host: '192.168.3.163', port: 49217 },
    { deviceId: 'dev_2', name: 'PC6', host: 'fe80::1', port: 49218 },
  ])
  assert.equal(matchDiscoveredEndpoint('dev_1', peers), 'http://192.168.3.163:49217')
  assert.equal(matchDiscoveredEndpoint('dev_2', peers), 'http://[fe80::1]:49218')
  assert.equal(matchDiscoveredEndpoint('dev_missing', peers), null)
})
