<script setup lang="ts">
import { ref } from 'vue'
import { PhSquaresFour, PhDownloadSimple, PhChatsCircle, PhPackage, PhPaperPlaneTilt, PhChartBar, PhGear } from '@phosphor-icons/vue'
import { primaryNav, settingsNav, type NavItem, type PageId } from '../data/navigation'

defineProps<{ current: PageId }>()

const emit = defineEmits<{ navigate: [page: PageId] }>()

/** 窄屏下导航默认折叠，桌面端该状态无效（CSS 始终展示导航）。 */
const menuOpen = ref(false)
const icons = { overview: PhSquaresFour, collect: PhDownloadSimple, chat: PhChatsCircle, products: PhPackage, publish: PhPaperPlaneTilt, analytics: PhChartBar, settings: PhGear }

function go(item: NavItem): void {
  menuOpen.value = false
  emit('navigate', item.id)
}
</script>

<template>
  <aside class="sidebar" :class="{ 'is-open': menuOpen }">
    <div class="sidebar__head">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true">F</span>
        <div class="brand__text">
          <p class="brand__name">FishOps</p>
          <p class="brand__sub">闲鱼运营工作台</p>
        </div>
      </div>
      <button
        type="button"
        class="sidebar__toggle"
        aria-controls="primary-nav"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        {{ menuOpen ? '收起' : '菜单' }}
      </button>
    </div>

    <nav id="primary-nav" class="nav" aria-label="主导航">
      <ul class="nav__list">
        <li v-for="item in primaryNav" :key="item.id">
          <button
            type="button"
            class="nav__item"
            :class="{ 'is-active': item.id === current }"
            :aria-current="item.id === current ? 'page' : undefined"
            @click="go(item)"
          >
            <component :is="icons[item.id]" :size="20" aria-hidden="true" />
            <span class="nav__label">{{ item.label }}</span>
          </button>
        </li>
      </ul>

      <div class="nav__footer">
        <button
          type="button"
          class="nav__item"
          :class="{ 'is-active': settingsNav.id === current }"
          :aria-current="settingsNav.id === current ? 'page' : undefined"
          @click="go(settingsNav)"
        >
          <PhGear :size="20" aria-hidden="true" />
          <span class="nav__label">{{ settingsNav.label }}</span>
        </button>
      </div>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  height: 100dvh;
  margin: 0;
  padding: 24px 12px 16px;
  border-radius: 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--sidebar-border);
  color: var(--sidebar-text);
}

.sidebar__head {
  padding: 2px 6px 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand__mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  font-size: 18px;
  font-weight: 800;
  border-radius: var(--radius-control);
  background: var(--accent);
  color: var(--on-accent);
}

.brand__name {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--text);
}

.brand__sub {
  font-size: 12px;
  line-height: 1.3;
  color: var(--sidebar-muted);
}

.sidebar__toggle {
  display: none;
}

.nav {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.nav__list {
  display: grid;
  gap: 2px;
}

.nav__footer {
  display: grid;
  gap: 8px;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--sidebar-border);
}

.nav__version {
  padding: 0 10px;
  font-size: 11.5px;
  color: var(--sidebar-muted);
}

.nav__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 0 10px;
  font-size: 14px;
  text-align: left;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--sidebar-text);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.nav__item:hover {
  background: var(--sidebar-hover);
  color: var(--text);
}

.nav__item:active {
  background: var(--sidebar-active);
}

.nav__item:focus-visible {
  outline-color: #9bbcff;
  outline-offset: -2px;
}

.nav__item.is-active {
  background: var(--sidebar-active);
  color: var(--text);
  font-weight: 600;
}

/* 选中指示条：琥珀色，仅在选中项出现 */
.nav__item.is-active::before {
  content: "";
  position: absolute;
  left: -10px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.nav__glyph {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--radius-control);
  background: rgba(255, 255, 255, 0.07);
  color: var(--sidebar-text);
}

.nav__item.is-active .nav__glyph {
  background: var(--accent);
  color: var(--on-accent);
}

.nav__label {
  flex: 1;
}

.nav__phase {
  padding: 1px 6px;
  font-size: 11px;
  font-family: var(--mono);
  border-radius: var(--radius-tag);
  border: 1px solid var(--sidebar-border);
  color: var(--sidebar-muted);
}

/* 窄屏：侧栏变为顶部栏，导航可折叠 */
@media (max-width: 899px) {
  .sidebar {
    top: 8px;
    z-index: 20;
    height: auto;
    margin: 8px 8px 0;
    padding: 10px;
  }

  .sidebar__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0;
  }

  .sidebar__toggle {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0 14px;
    font-size: 13px;
    border: 1px solid var(--sidebar-border);
    border-radius: var(--radius-control);
    background: var(--sidebar-hover);
    color: var(--text);
    cursor: pointer;
  }

  .sidebar__toggle:hover {
    background: var(--sidebar-active);
  }

  .sidebar__toggle:focus-visible {
    outline-color: #9bbcff;
  }

  .nav {
    display: none;
    max-height: calc(100vh - 100px);
    overflow-y: auto;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--sidebar-border);
  }

  .sidebar.is-open .nav {
    display: flex;
  }

  /* 折叠面板带 overflow，指示条需收进容器内 */
  .nav__item.is-active::before {
    left: 0;
  }
}
</style>
