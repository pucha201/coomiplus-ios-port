export type SpeakMode = 'round_robin' | 'open' | 'host'
export type RoomStatus = 'idle' | 'running' | 'done'
export type RoomEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra'

export interface RoomMember {
  id: string
  name: string
  modelSelector: string
  prompt: string
  color: string
  icon: string
  /** 每人发言上限，0 = 不限 */
  quota: number
  /** 人设描述 */
  persona?: string
  /** 说话风格 / 口头禅 */
  speakingStyle?: string
  /** 价值观 / 立场 */
  values?: string
  /** 情绪倾向 -1 ~ 1 */
  emotionBias?: number
  /** 绑定的数字生命体 id */
  lifeId?: string
  /** 项目内共享身份 id（同名成员共用记忆） */
  identityId?: string
}

/** 项目内共享身份（通讯录 / 单聊对象）。 */
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
  /** 羁绊 0~1 */
  bond: number
  memoryCount: number
  turnCount: number
  milestonesHit: string[]
  relationshipScale: string
  lifeId?: string | null
  lifeState?: unknown
  roomIds: string[]
  createdAtMs: number
  lastSeenMs: number
  dmUnread: number
}

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

export interface DmMessage {
  id: string
  /** "user" | identityId */
  from: string
  content: string
  kind: string
  /** 秒级时间戳 */
  ts: number
  attachments?: string[]
}

export interface CreateRoomResult {
  room: Room
  /** 已存在同名身份、沿用记忆的成员名 */
  reusedIdentities: string[]
}

export interface RoomMessage {
  id: string
  from: string
  to: string
  content: string
  kind: 'user' | 'agent' | 'system' | 'topic'
  ts: number
  /** 附件路径（图片/文件） */
  attachments?: string[]
  /** 引用的消息 id */
  replyTo?: string
}

export interface MemberActivity {
  id: string
  kind: string
  memberId: string
  detail: string
  atMs: number
  messageId?: string
}

export interface MemberActivityPayload {
  member: RoomMember | null
  workDir: string | null
  activities: MemberActivity[]
  recentMessages: RoomMessage[]
}

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
  workDir?: string | null
  idleChatEnabled?: boolean
  /** 消息免打扰 */
  muted?: boolean
  /** 所属项目 id */
  projectId?: string
  createdAtMs: number
  updatedAtMs: number
}

export interface RoomSummary {
  id: string
  name: string
  topic: string
  status: RoomStatus
  speakMode: SpeakMode
  memberCount: number
  memberColors: string[]
  preview: string
  messageCount: number
  updatedAtMs: number
  reasoningEffort: RoomEffort
  muted?: boolean
  projectId?: string
}

export interface IdentityMemoryPage {
  items: unknown[]
  total: number
}

export interface HomeConversation {
  kind: 'room'
  id: string
  title: string
  subtitle: string
  preview: string
  updatedAtMs: number
  running: boolean
  badge: number
  memberCount: number
  speakMode: SpeakMode
  color: string
}
