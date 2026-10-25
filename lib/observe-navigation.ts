export type ObserveModule = 'content' | 'wechat';
export type WeChatPage = 'reading' | 'manage';
export type ObserveNavigation = { module: ObserveModule; contentView: string; wechatView: WeChatPage };
export const OBSERVE_NAV_KEY = 'observe.navigation.v1';
export const CONTENT_VIEWS = ['内容浏览', '链接分析', '互动数据', '信源管理'];
const contentSlugs = ['browse', 'links', 'analytics', 'sources'];
export function resolveObserveNavigation(search: string, stored: Partial<ObserveNavigation> = {}): ObserveNavigation {
  const params = new URLSearchParams(search);
  const selectedModule = params.has('module') ? (params.get('module') === 'wechat' ? 'wechat' : 'content') : stored.module === 'wechat' ? 'wechat' : 'content';
  const savedContent = CONTENT_VIEWS.includes(stored.contentView || '') ? stored.contentView! : CONTENT_VIEWS[0];
  const index = selectedModule === 'content' ? contentSlugs.indexOf(params.get('view') || '') : -1;
  return { module: selectedModule, contentView: index >= 0 ? CONTENT_VIEWS[index] : savedContent,
    wechatView: selectedModule === 'wechat' && params.has('view') ? (params.get('view') === 'manage' ? 'manage' : 'reading') : stored.wechatView === 'manage' ? 'manage' : 'reading' };
}
export function observeSearch(state: ObserveNavigation): string {
  return `?module=${state.module}&view=${state.module === 'wechat' ? state.wechatView : contentSlugs[Math.max(0, CONTENT_VIEWS.indexOf(state.contentView))]}`;
}
