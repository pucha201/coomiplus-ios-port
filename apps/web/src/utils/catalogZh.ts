/** 内置目录 / 市场条目的中文展示映射（英文看不懂时的兜底汉化）。 */
const ZH: Record<string, { name?: string; desc?: string }> = {
  'skill-creator': { name: '技能创建器', desc: '创建并更新可复用的 Coomi 技能。' },
  'frontend-design': { name: '前端设计', desc: '构建可生产、可访问的前端界面。' },
  'webapp-testing': { name: 'Web 应用测试', desc: '用浏览器自动化验证本地 Web 应用。' },
  'code-review': { name: '代码评审', desc: '审查正确性、可维护性与测试覆盖率。' },
  'security-review': { name: '安全审查', desc: '发现安全缺陷并给出可验证修复。' },
  'react-nextjs': { name: 'React 最佳实践', desc: '应用 React / Next.js 性能与工程实践。' },
  'api-design': { name: 'API 设计原则', desc: '设计一致、可演进的 HTTP API。' },
  'git-workflow': { name: 'Git 进阶工作流', desc: '安全使用分支、rebase、worktree 与恢复。' },
  'technical-writing': { name: '技术文档写作', desc: '撰写准确、可执行的开发者文档。' },
  'shizuku': { name: 'Shizuku 授权检查', desc: '特权 Android 操作前检查 Shizuku 授权。' },
  'coomi-custom-iteration': { name: 'Coomi 定制迭代', desc: '安全开发 Coomi、提交 PR 或构建 CoomiDev。' },
  'runtime-environments': { name: '运行时环境', desc: '在 Host / Termux / ProotLinux 间正确路由工具与路径。' },
  filesystem: { name: '文件系统 MCP', desc: '本地文件读写 MCP 服务。' },
  git: { name: 'Git MCP', desc: 'Git 仓库操作 MCP 服务。' },
  fetch: { name: '网络抓取 MCP', desc: 'HTTP 抓取 MCP 服务。' },
  memory: { name: '记忆 MCP', desc: '长期记忆读写 MCP 服务。' },
  playwright: { name: 'Playwright MCP', desc: '浏览器自动化 MCP（需本机已装 Playwright）。' },
  github: { name: 'GitHub MCP', desc: 'GitHub 仓库 / Issue / PR 操作。' },
}

export function zhName(id: string, fallback: string): string {
  return ZH[id]?.name || fallback
}

export function zhDesc(id: string, fallback: string): string {
  return ZH[id]?.desc || fallback
}

/** 把常见英文关键词替换为中文提示，用于市场远端描述。 */
export function softenEn(text: string): string {
  if (!text) return text
  const map: Array<[RegExp, string]> = [
    [/\bCreate and update\b/gi, '创建并更新'],
    [/\bBuild production-quality\b/gi, '构建可生产质量的'],
    [/\bVerify\b/gi, '验证'],
    [/\bReview\b/gi, '审查'],
    [/\bFind security\b/gi, '发现安全'],
    [/\bApply current\b/gi, '应用当前'],
    [/\bDesign\b/gi, '设计'],
    [/\bUse branches\b/gi, '使用分支'],
    [/\bWrite accurate\b/gi, '撰写准确'],
    [/\bSkills?\b/g, '技能'],
    [/\bMCP\b/g, 'MCP'],
    [/\bserver\b/gi, '服务'],
  ]
  let out = text
  for (const [re, to] of map) out = out.replace(re, to)
  return out
}
