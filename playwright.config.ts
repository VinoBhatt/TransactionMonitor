import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir:'./tests', fullyParallel:false, workers:1,
  use:{baseURL:'http://127.0.0.1:8788',browserName:'chromium',timezoneId:'Asia/Kuala_Lumpur'},
  webServer:{command:'node --experimental-strip-types tests/server.mjs',url:'http://127.0.0.1:8788',reuseExistingServer:false,timeout:120000},
})
