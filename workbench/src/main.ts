import { createApp } from 'vue'
import App from './App.vue'
import { initTheme } from './composables/useTheme'
import './styles.css'

// 先应用已保存的主题，再挂载应用，避免首屏闪烁。
initTheme()

createApp(App).mount('#app')
