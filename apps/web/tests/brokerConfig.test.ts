import assert from 'node:assert/strict'
import test from 'node:test'
import { brokerUrlFor, isBrokerUrlAllowed, DEFAULT_SYNC_BROKER_URL } from '../src/utils/brokerConfig.ts'

test('the broker carried by the pairing code wins over env and default', () => {
  assert.equal(
    brokerUrlFor({ brokerUrl: 'wss://mqtt.office.example:8084/mqtt' }, 'wss://build.example/mqtt'),
    'wss://mqtt.office.example:8084/mqtt',
  )
})

test('a broker-less pairing code falls back to the build-time override', () => {
  assert.equal(brokerUrlFor({ brokerUrl: '' }, 'wss://build.example/mqtt'), 'wss://build.example/mqtt')
  assert.equal(brokerUrlFor(null, 'wss://build.example/mqtt'), 'wss://build.example/mqtt')
})

test('nothing configured keeps the public default instead of throwing', () => {
  assert.equal(brokerUrlFor(undefined, undefined), DEFAULT_SYNC_BROKER_URL)
  assert.equal(brokerUrlFor({ brokerUrl: '   ' }, ''), DEFAULT_SYNC_BROKER_URL)
})

test('a broker that is not a websocket address is rejected outright', () => {
  assert.equal(brokerUrlFor({ brokerUrl: 'http://192.168.1.10:1883' }, 'wss://build.example/mqtt'), 'wss://build.example/mqtt')
  assert.equal(isBrokerUrlAllowed('mqtt://broker.emqx.io'), false)
  assert.equal(isBrokerUrlAllowed('wss://'), false)
})

test('plaintext ws is only accepted for localhost and LAN addresses', () => {
  assert.equal(isBrokerUrlAllowed('ws://localhost:8084/mqtt'), true)
  assert.equal(isBrokerUrlAllowed('ws://192.168.1.10:8084/mqtt'), true)
  assert.equal(isBrokerUrlAllowed('ws://10.0.0.5:8084/mqtt'), true)
  assert.equal(isBrokerUrlAllowed('ws://172.16.0.2:8084/mqtt'), true)
  assert.equal(isBrokerUrlAllowed('ws://broker.emqx.io:8084/mqtt'), false)
  assert.equal(isBrokerUrlAllowed('ws://8.8.8.8:8084/mqtt'), false)
})
