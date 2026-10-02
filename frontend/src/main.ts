import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { initBlowDatabase } from '@/utils/blowDb'
import { initKilnDatabase } from '@/utils/kilnDb'
import '@/styles/main.css'

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

// 首屏即打开两侧 IndexedDB：吹侧先完成旧库迁移/播种，排侧随后迁移退火表。
// 两侧各持各的库，一侧打不开不影响另一侧（store 内对跨侧错误做了降级）。
const blowReady = initBlowDatabase()
void initKilnDatabase(blowReady)

app.mount('#app')
