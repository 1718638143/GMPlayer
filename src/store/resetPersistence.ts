/**
 * 「系统重置」的持久化清理入口。
 *
 * localStorage 只是其中一层：Tauri 环境下 settingData / siteData / userData
 * 还落在 Tauri store 文件里。只 `localStorage.clear()` 的话，重载后这几个
 * store 会从文件里重新 hydrate 回来，重置等于没做。
 *
 * 主窗口（App.vue 的 $cleanAll）和从设置窗口（SettingsWorkspace 的兜底
 * 实现）都走这里，避免两处逻辑漂移。
 */
import {
  destroyTauriPiniaStores,
  isTauriPiniaInstalled,
} from "@/utils/tauri/store/piniaPersistence";
import { suspendMusicPersist } from "./musicPersistedData";
import useSettingDataStore, { settingStorage } from "./settingData";
import useSiteDataStore from "./siteData";
import useUserDataStore from "./userData";

/**
 * 清空所有持久化层。调用方负责随后重载页面。
 *
 * 先销毁 Tauri store 再清 localStorage：destroy 内部有超时兜底，即使 IPC
 * 卡住，localStorage 也一定会被清掉。
 */
export async function resetPersistedStorage(): Promise<void> {
  suspendMusicPersist();
  // settingData 的写入是节流合并的，不挂起的话 clear 之后还会有尾调用落地，
  // 把刚清掉的设置原样写回去。
  settingStorage.suspend();
  if (isTauriPiniaInstalled()) {
    await destroyTauriPiniaStores([useSettingDataStore(), useSiteDataStore(), useUserDataStore()]);
  }
  localStorage.clear();
}
