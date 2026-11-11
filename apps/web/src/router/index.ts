import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'chat', component: () => import('@/views/ChatView.vue') },
    // 独立首页：类 QQ 三 Tab，与协同/主会话数据隔离
    // 互联功能已隐藏：/home 回首页
    { path: '/home', redirect: '/' },
    { path: '/im', redirect: '/' },
    // 单聊须在 /im/:roomId 之前匹配
    { path: '/im/dm/:identityId', redirect: '/' },
    { path: '/im/:roomId', redirect: '/' },
    { path: '/sessions', name: 'sessions', component: () => import('@/views/SessionsView.vue') },
    { path: '/sessions/archived', name: 'sessions-archived', component: () => import('@/views/ArchivedSessionsView.vue') },
    { path: '/tasks', name: 'tasks', component: () => import('@/views/TasksView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/settings/ai', name: 'settings-ai', component: () => import('@/views/settings/AiSettingsView.vue') },
    { path: '/settings/general', name: 'settings-general', component: () => import('@/views/settings/GeneralSettingsView.vue') },
    { path: '/settings/connection', name: 'settings-connection', component: () => import('@/views/settings/ConnectionSettingsView.vue') },
    { path: '/reverse-experiments', name: 'reverse-experiments', component: () => import('@/views/ReverseExperimentsView.vue') },
    { path: '/appearance', name: 'appearance', component: () => import('@/views/AppearanceView.vue') },
    { path: '/persona', name: 'persona', component: () => import('@/views/PersonaView.vue') },
    { path: '/providers', name: 'providers', component: () => import('@/views/ProvidersView.vue') },
    { path: '/providers/new', name: 'provider-new', component: () => import('@/views/ProviderDetailView.vue') },
    { path: '/providers/:id', name: 'provider-detail', component: () => import('@/views/ProviderDetailView.vue') },
    { path: '/runtime', name: 'runtime', component: () => import('@/views/RuntimeView.vue') },
    { path: '/devices', name: 'devices', component: () => import('@/views/DevicesView.vue') },
    { path: '/backup', name: 'backup', component: () => import('@/views/BackupView.vue') },
    { path: '/about', name: 'about', component: () => import('@/views/AboutView.vue') },
    { path: '/custom-iteration', name: 'custom-iteration', component: () => import('@/views/CustomIterationView.vue') },
    { path: '/life', name: 'life', component: () => import('@/views/LifeView.vue') },
    { path: '/life/memory', name: 'life-memory', component: () => import('@/views/LifeMemoryView.vue') },
    { path: '/life/journal', name: 'life-journal', component: () => import('@/views/LifeJournalView.vue') },
    { path: '/catalog', alias: '/extensions', name: 'catalog', component: () => import('@/views/ExtensionsView.vue') },
    { path: '/workflows', name: 'workflows', component: () => import('@/views/WorkflowView.vue') },
    { path: '/hooks', name: 'hooks', component: () => import('@/views/HooksView.vue') },
    { path: '/memory', name: 'memory', component: () => import('@/views/MemoryView.vue') },
    { path: '/files', name: 'files', component: () => import('@/views/FileManagerView.vue') },
    { path: '/maintenance', name: 'maintenance', component: () => import('@/views/MaintenanceView.vue') },
    { path: '/usage', name: 'usage', component: () => import('@/views/UsageView.vue') },
    { path: '/updates', name: 'updates', component: () => import('@/views/UpdatesView.vue') },
    { path: '/collab', redirect: '/' },
    { path: '/collab/new', redirect: '/' },
    { path: '/collab/create', redirect: '/' },
    { path: '/collab/workspace', redirect: '/' },
    { path: '/collab/:taskId', redirect: '/' },
    // 旧路径兼容：群聊一律走独立 /home，不再绑 collab
    { path: '/collab-chat', redirect: '/' },
    { path: '/collab-chat/:roomId', redirect: '/' },
  ],
})

// vendor 弹层（选择设备 / 添加设备 / 云端设置）挂在 body 上，不感知路由；
// 不主动关的话，切到任何页面它都继续盖在上面。
router.afterEach(() => {
  try { (window as unknown as { __coomiCloudApi?: { closeSheet?: () => void } }).__coomiCloudApi?.closeSheet?.() } catch { /* vendor 未注入时忽略 */ }
})
