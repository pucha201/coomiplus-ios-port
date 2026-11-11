/** 群聊类型定义：与后端 group/types.rs 对应。 */

// ── 枚举 ────────────────────────────────────────────────────

export type SpeakMode = 'round_robin' | 'open' | 'host'
export type RoomStatus = 'idle' | 'running' | 'done'
export type RoomEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra'

// ── 成员 ────────────────────────────────────────────────────

export interface RoomMember {
  id: string
  name: string
  modelSelector: string
  prompt: string
  color: string
  icon: string
  quota: number
  persona: string
  speakingStyle: string
  values: string
  emotionBias: number
  lifeId?: string
  identityId?: string
}

// ── 消息 ────────────────────────────────────────────────────

export interface RoomMessage {
  id: string
  from: string
  to: string
  content: string
  kind: string
  ts: number
  attachments: string[]
  replyTo?: string
}

// ── 活动 ────────────────────────────────────────────────────

export interface MemberActivity {
  id: string
  kind: string
  memberId: string
  detail: string
  atMs: number
  messageId?: string
}

// ── 房间 ────────────────────────────────────────────────────

export interface Room {
  id: string
  name: string
  topic: string
  status: RoomStatus
  speakMode: SpeakMode
  members: RoomMember[]
  messages: RoomMessage[]
  nextSpeaker: number
  speakCounts: Record<string, number>
  hostAllow: string[]
  reasoningEffort: RoomEffort
  contextPaths: string[]
  workDir?: string
  activities: MemberActivity[]
  idleChatEnabled: boolean
  muted: boolean
  projectId?: string
  createdAtMs: number
  updatedAtMs: number
}

/** 列表摘要：不带 messages / activities。 */
export interface RoomSummary {
  id: string
  name: string
  topic: string
  status: RoomStatus
  speakMode: SpeakMode
  memberCount: number
  memberColors: string[]
  memberIds?: string[]
  preview: string
  messageCount: number
  updatedAtMs: number
  reasoningEffort: RoomEffort
  muted: boolean
  projectId?: string
  messages?: never[]
  activities?: never[]
}

// ── 项目 ────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string
  name: string
  description: string
  createdAtMs: number
  updatedAtMs: number
  roomCount: number
  identityCount: number
  roomIds: string[]
}

// ── 身份 / 通讯录 ───────────────────────────────────────────

export interface Identity {
  id: string
  name: string
  nameKey: string
  persona: string
  speakingStyle: string
  values: string
  modelSelector: string
  color: string
  icon: string
  mood: number
  valence: number
  arousal: number
  attention: string
  bond: number
  memoryCount: number
  turnCount: number
  milestonesHit: string[]
  relationshipScale: 'light' | 'standard' | 'deep'
  lifeId?: string
  lifeState?: unknown
  roomIds: string[]
  createdAtMs: number
  lastSeenMs: number
  dmUnread: number
}

export interface IdentityMemoryPage {
  items: unknown[]
  total: number
}

// ── 单聊 ────────────────────────────────────────────────────

export interface DmMessage {
  id: string
  from: string
  content: string
  kind: string
  ts: number
  attachments: string[]
}

// ── 创建结果 ────────────────────────────────────────────────

export interface CreateRoomResult {
  room: Room
  reusedIdentities: string[]
}

// ── 成员活动详情 ────────────────────────────────────────────

export interface MemberActivityPayload {
  activities: MemberActivity[]
  member: RoomMember | null
  recentMessages: RoomMessage[]
}
