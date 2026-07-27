<template>
  <n-drawer
    v-if="useDrawerLayout"
    class="playlist-drawer"
    :show="playListShow"
    :z-index="2200"
    :width="400"
    :show-mask="false"
    :trap-focus="false"
    :block-scroll="false"
    placement="right"
    to="body"
    @update:show="handleDrawerShowUpdate"
    @after-leave="handleDrawerAfterLeave"
  >
    <n-drawer-content
      class="playlist-drawer-content"
      :native-scrollbar="true"
      :body-content-style="{ padding: 0, height: '100%' }"
      closable
    >
      <template #header>
        <n-text class="playlist-title">{{ $t("general.name.playlists") }}</n-text>
      </template>
      <QueuePanel ref="queuePanelRef" />
    </n-drawer-content>
  </n-drawer>
</template>

<script setup>
import { musicStore } from "@/store";
import { PLAYLIST_DRAWER_MEDIA_QUERY } from "@/utils/playlistLayout";
import QueuePanel from "@/components/QueuePanel/index.vue";

const music = musicStore();

// 播放列表显隐
const useDrawerLayout = ref(false);
let drawerMediaQuery = null;
const playListShow = ref(false);
const queuePanelRef = ref(null);

const handleDrawerAfterLeave = () => {
  if (useDrawerLayout.value && !playListShow.value && music.showPlayList) {
    music.showPlayList = false;
  }
};

const handleDrawerShowUpdate = (show) => {
  if (!show) {
    playListShow.value = false;
    return;
  }
  if (useDrawerLayout.value && music.showPlayList) {
    playListShow.value = true;
  }
};

// 打开时滚动到当前播放曲目
const scrollToCurrentSong = () => {
  nextTick().then(() => {
    if (playListShow.value) queuePanelRef.value?.scrollToCurrent();
  });
};

const syncDrawerLayout = (event) => {
  useDrawerLayout.value = event?.matches ?? drawerMediaQuery?.matches ?? true;
};

watch(
  () => music.showPlayList,
  (show) => {
    if (useDrawerLayout.value) {
      playListShow.value = show;
    } else {
      playListShow.value = false;
    }
    scrollToCurrentSong();
  },
);

watch(
  () => useDrawerLayout.value,
  (isDrawerLayout) => {
    playListShow.value = isDrawerLayout ? music.showPlayList : false;
    scrollToCurrentSong();
  },
);

onMounted(() => {
  if (typeof window !== "undefined") {
    drawerMediaQuery = window.matchMedia(PLAYLIST_DRAWER_MEDIA_QUERY);
    syncDrawerLayout();
    drawerMediaQuery.addEventListener("change", syncDrawerLayout);
  } else {
    useDrawerLayout.value = true;
  }
});

onBeforeUnmount(() => {
  drawerMediaQuery?.removeEventListener("change", syncDrawerLayout);
});
</script>

<style lang="scss">
.playlist-drawer {
  width: 400px !important;
  border-radius: 0;
  transition: width var(--duration-300) var(--ease-out);

  .n-drawer-header {
    height: 60px;
    box-sizing: border-box;
  }

  // QueuePanel 自管滚动与内边距，抽屉主体不再包滚动容器
  .n-drawer-body-content-wrapper {
    padding: 0 !important;
    height: 100%;
  }

  @media (max-width: 700px) {
    width: 100% !important;
    border-radius: 0;
  }
}
</style>

<style lang="scss" scoped>
.playlist-title {
  font-size: 15px;
  font-weight: 700;
}
</style>
