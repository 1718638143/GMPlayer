import { createApp } from "vue";
import { createPinia } from "pinia";
import { useI18n } from "@/locale";
import { useSafeAreaVars } from "./composables/useSafeAreaVars";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";

import App from "@/App.vue";
import router from "@/router/index";
import { audioPreheat } from "@/utils/tauri/audio/bridge";
import { isTauri } from "@/utils/tauri/core/runtime";
import { installExternalLinkInterceptor } from "@/utils/openLink";

// 全局样式
import "@/style/global.scss";
import "@/style/animate.scss";

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

const app = createApp(App).use(pinia).use(router);

// 国际化
useI18n(app);

useSafeAreaVars();

// 外链统一出口：Tauri 交给系统浏览器，Web 走新标签页
installExternalLinkInterceptor();

app.mount("#app");

if (isTauri()) {
  void audioPreheat().catch((err) => {
    console.warn("[main] native audio preheat failed", err);
  });
}

if ("serviceWorker" in navigator) {
  let pwaMessage: { destroy: () => void } | null = null;

  // 检测到更新提醒
  navigator.serviceWorker.addEventListener("onupdatefound", () => {
    console.info("发现站点更新，正在下载新版本");
    pwaMessage = $message.loading("发现站点更新，正在下载新版本", {
      closable: true,
      duration: 0,
    });
  });

  // 更新完成提醒
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    console.info("站点已更新，刷新后生效");
    if (pwaMessage) pwaMessage?.destroy();
    $message.info("站点已更新，刷新后生效", {
      closable: true,
      duration: 0,
    });
  });
}
